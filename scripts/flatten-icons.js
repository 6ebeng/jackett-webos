// One-off helper: flatten the app icons onto a solid, full-bleed white
// background so the LG launcher tile shows no dark corners/padding through the
// icon's transparency. The launcher applies its own rounded-corner mask, so the
// source icon must be fully opaque edge-to-edge.
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const files = [
	path.join(__dirname, '..', 'appinfo', 'icon.png'),
	path.join(__dirname, '..', 'appinfo', 'largeIcon.png'),
	path.join(__dirname, '..', 'appinfo', 'icon-notify.png'),
	path.join(__dirname, '..', 'icon.png'),
];

function flatten(file) {
	const png = PNG.sync.read(fs.readFileSync(file));
	for (let i = 0; i < png.data.length; i += 4) {
		const a = png.data[i + 3] / 255;
		// Alpha-composite the pixel over white, then output fully opaque.
		png.data[i] = Math.round(png.data[i] * a + 255 * (1 - a));
		png.data[i + 1] = Math.round(png.data[i + 1] * a + 255 * (1 - a));
		png.data[i + 2] = Math.round(png.data[i + 2] * a + 255 * (1 - a));
		png.data[i + 3] = 255;
	}
	fs.writeFileSync(file, PNG.sync.write(png));
	console.log('flattened', path.basename(file), png.width + 'x' + png.height);
}

files.forEach(flatten);
