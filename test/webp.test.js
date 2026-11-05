import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeWebP } from '../src/image/webp.js';
import { decodeImage } from '../src/image/index.js';

const python = new URL( '../.venv/Scripts/python.exe', import.meta.url );
const pythonPath = existsSync( python ) ? python.pathname.replace( /^\/([A-Za-z]:)/, '$1' ) : null;

function hasPillow() {

	if ( ! pythonPath ) return false;
	try { execFileSync( pythonPath, [ '-c', 'import PIL' ] ); return true; } catch { return false; }

}

const skip = ! hasPillow() && 'Pillow is not available';

// Pillow writes the fixtures and decodes them (with libwebp) as the reference.
const ORACLE = `
import sys, json, random
from PIL import Image, ImageDraw
out = sys.argv[1]
random.seed(7)
cases = []
def photo(w, h, alpha=False):
    im = Image.new('RGBA' if alpha else 'RGB', (w, h))
    d = ImageDraw.Draw(im)
    for i in range(60):
        x0, y0 = random.randrange(w), random.randrange(h)
        c = tuple(random.randrange(256) for _ in range(4 if alpha else 3))
        d.ellipse([x0, y0, x0 + random.randrange(1, w + 1), y0 + random.randrange(1, h + 1)], fill=c)
    px = im.load()
    for y in range(h):
        for x in range(0, w, 3):
            p = list(px[x, y]); p[0] = (p[0] + x + y) % 256; px[x, y] = tuple(p)
    return im
for (w, h) in [(1, 1), (17, 9), (333, 257), (64, 64)]:
    for q in [5, 50, 95]:
        cases.append((f'lossy_{w}x{h}_q{q}.webp', photo(w, h), dict(quality=q)))
    cases.append((f'lossy_alpha_{w}x{h}.webp', photo(w, h, True), dict(quality=80)))
    cases.append((f'lossless_{w}x{h}.webp', photo(w, h), dict(lossless=True)))
    cases.append((f'lossless_alpha_{w}x{h}.webp', photo(w, h, True), dict(lossless=True)))
cases.append(('lossless_palette.webp', photo(120, 80).quantize(4).convert('RGB'), dict(lossless=True)))
cases.append(('lossless_gradient.webp', Image.linear_gradient('L').convert('RGB'), dict(lossless=True, method=6)))
cases.append(('lossy_big.webp', photo(1024, 768), dict(quality=75, method=6)))
for name, im, opts in cases:
    path = out + '/' + name
    im.save(path, 'WEBP', **opts)
    ref = Image.open(path); ref.load()
    mode = 'RGBA' if 'A' in ref.getbands() else 'RGB'
    ref = ref.convert(mode)
    open(path + '.raw', 'wb').write(ref.tobytes())
    print(json.dumps({'name': name, 'width': ref.width, 'height': ref.height, 'channels': len(mode)}))
`;

test( 'decodes WebP exactly like libwebp', { skip }, () => {

	const dir = mkdtempSync( join( tmpdir(), 'usd-gltf-webp-' ) );
	writeFileSync( join( dir, 'oracle.py' ), ORACLE );
	const cases = execFileSync( pythonPath, [ join( dir, 'oracle.py' ), dir ], { encoding: 'utf8' } ).trim().split( '\n' ).map( JSON.parse );
	assert.ok( cases.length > 20 );

	for ( const c of cases ) {

		const image = decodeWebP( new Uint8Array( readFileSync( join( dir, c.name ) ) ) );
		assert.deepEqual( [ image.width, image.height, image.channels ], [ c.width, c.height, c.channels ], c.name );
		const ref = readFileSync( join( dir, c.name + '.raw' ) );
		let max = 0;
		for ( let i = 0; i < ref.length; i ++ ) max = Math.max( max, Math.abs( ref[ i ] - image.data[ i ] ) );
		assert.equal( max, 0, `${ c.name } differs from libwebp by up to ${ max }` );

	}

} );

const sofa = new URL( '../corpus/khronos/Models/SheenWoodLeatherSofa/glTF/', import.meta.url );

test( 'decodes the corpus WebP textures through decodeImage', { skip: ! existsSync( sofa ) && 'corpus not downloaded' }, () => {

	for ( const name of readdirSync( sofa ).filter( ( f ) => f.endsWith( '.webp' ) ) ) {

		const image = decodeImage( new Uint8Array( readFileSync( new URL( name, sofa ) ) ) );
		assert.ok( image.width > 0 && image.data.length === image.width * image.height * image.channels, name );

	}

} );
