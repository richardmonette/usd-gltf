import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { inflate, inflateZlib } from '../src/image/inflate.js';
import { deflate, deflateZlib } from '../src/image/deflate.js';
import { decodePNG, encodePNG } from '../src/image/png.js';
import { decodeJPEG } from '../src/image/jpeg.js';
import { decodeImage, imageMimeType } from '../src/image/index.js';

const ROOT = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '..' );
const CORPUS = path.join( ROOT, 'corpus', 'khronos', 'Models' );
const PYTHON = process.env.PYTHON || path.join( ROOT, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python' );

// Pillow based fixture generator and oracle. Modes:
//   gen <dir>             write PNG / JPEG / zlib fixtures and manifest.json
//   ref <list> <dir>      decode each listed file with Pillow, write raw pixels, print JSON
//   zcheck <dir>          decompress *.z (zlib) and *.raw (raw deflate) and compare with *.orig
const ORACLE = `
import sys, os, json, zlib, struct, random
from PIL import Image, ImageDraw

def png_header(path):
    with open(path, 'rb') as f:
        h = f.read(33)
    if h[:8] != bytes([137, 80, 78, 71, 13, 10, 26, 10]):
        return None
    return h[24], h[25]  # bit depth, color type

# Pillow's decode in the decoder's output convention: (channels, bitDepth, bytes, msbOnly) or None
def pillow_ref(path):
    im = Image.open(path)
    im.load()
    m = im.mode
    t = im.info.get('transparency')
    if im.format == 'JPEG':
        if m == 'L':
            return 1, 8, im.tobytes(), False
        return 3, 8, im.convert('RGB').tobytes(), False
    bd, ct = png_header(path)
    if ct == 3:
        if t is not None:
            return 4, 8, im.convert('RGBA').tobytes(), False
        return 3, 8, im.convert('RGB').tobytes(), False
    if t is not None and (bd != 8 or ct not in (0, 2)):
        return None  # Pillow compares 16 bit or packed keys against converted samples
    if bd == 16 and ct == 0:
        return 1, 16, im.tobytes('raw', 'I;16'), False
    if m == '1':
        im = im.convert('L')
        m = 'L'
    msb = bd == 16
    if ct == 4 and m == 'RGBA':
        # Pillow opens 16 bit gray + alpha as RGBA (high bytes)
        d = im.tobytes()
        out = bytearray(len(d) // 2)
        out[0::2] = d[0::4]
        out[1::2] = d[3::4]
        return 2, 8, bytes(out), msb
    if m == 'L':
        if t is not None:
            return 2, 8, im.convert('LA').tobytes(), False
        return 1, 8, im.tobytes(), False
    if m == 'LA':
        return 2, 8, im.tobytes(), msb
    if m == 'RGB':
        if t is not None:
            return 4, 8, im.convert('RGBA').tobytes(), False
        return 3, 8, im.tobytes(), msb
    if m == 'RGBA':
        return 4, 8, im.tobytes(), msb
    return None

def write_ref(src, out):
    r = pillow_ref(src)
    if r is None:
        return None
    ch, bd, data, msb = r
    with open(out, 'wb') as f:
        f.write(data)
    im = Image.open(src)
    return { 'file': out, 'width': im.size[0], 'height': im.size[1], 'channels': ch, 'bitDepth': bd, 'msb': msb }

def chunk(t, d):
    return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)

ADAM7 = [(0, 0, 8, 8), (4, 0, 8, 8), (0, 4, 4, 8), (2, 0, 4, 4), (0, 2, 2, 4), (1, 0, 2, 2), (0, 1, 1, 2)]
SAMPLES = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}

def pack_row(px, ch, bd):
    if bd == 16:
        return b''.join(struct.pack('>%dH' % ch, *p) for p in px)
    if bd == 8:
        return bytes(v for p in px for v in p)
    out = bytearray()
    acc = 0
    n = 0
    for p in px:
        acc = (acc << bd) | p[0]
        n += bd
        if n == 8:
            out.append(acc)
            acc = 0
            n = 0
    if n:
        out.append(acc << (8 - n))
    return bytes(out)

def paeth(a, b, c):
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    return b if pb <= pc else c

def filt(raw, prev, bpp, ft):
    out = bytearray(len(raw))
    for i in range(len(raw)):
        a = raw[i - bpp] if i >= bpp else 0
        b = prev[i]
        c = prev[i - bpp] if i >= bpp else 0
        pred = (0, a, b, (a + b) >> 1, paeth(a, b, c))[ft]
        out[i] = (raw[i] - pred) & 255
    return bytes(out)

def write_png(path, w, h, ct, bd, pix, interlace, rng, palette, trns):
    ch = SAMPLES[ct]
    bpp = max(1, ch * bd // 8)
    data = bytearray()
    for x0, y0, dx, dy in (ADAM7 if interlace else [(0, 0, 1, 1)]):
        pw = (w - x0 + dx - 1) // dx if w > x0 else 0
        ph = (h - y0 + dy - 1) // dy if h > y0 else 0
        if pw == 0 or ph == 0:
            continue
        prev = None
        for y in range(ph):
            raw = pack_row([pix[y0 + y * dy][x0 + x * dx] for x in range(pw)], ch, bd)
            ft = rng.randrange(5)
            data.append(ft)
            data += filt(raw, prev if prev is not None else bytes(len(raw)), bpp, ft)
            prev = raw
    png = bytes([137, 80, 78, 71, 13, 10, 26, 10])
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, bd, ct, 0, 0, 1 if interlace else 0))
    if palette is not None:
        png += chunk(b'PLTE', bytes(v for p in palette for v in p))
    if trns is not None:
        png += chunk(b'tRNS', trns)
    z = zlib.compress(bytes(data), 9)
    for i in range(0, len(z), 97):
        png += chunk(b'IDAT', z[i:i + 97])
    png += chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)

def synthetic_png(d, name, w, h, ct, bd, interlace, use_trns, seed):
    rng = random.Random(seed)
    ch = SAMPLES[ct]
    top = (1 << bd) - 1
    palette = trns = None
    key = None
    if ct == 3:
        n = 180 if bd == 8 else 1 << bd
        palette = [(rng.randrange(256), rng.randrange(256), rng.randrange(256)) for _ in range(n)]
        pix = [[(rng.randrange(n),) for x in range(w)] for y in range(h)]
        if use_trns:
            trns = bytes(rng.randrange(256) for _ in range(n // 2 + 1))
    else:
        pix = [[tuple(rng.randrange(top + 1) for _ in range(ch)) for x in range(w)] for y in range(h)]
        if use_trns:
            key = pix[0][0]
            for y in range(h):
                for x in range(w):
                    if rng.random() < 0.2:
                        pix[y][x] = key
            trns = b''.join(struct.pack('>H', v) for v in key)
    write_png(os.path.join(d, name + '.png'), w, h, ct, bd, pix, interlace, rng, palette, trns)
    out = []
    amax = 65535 if bd == 16 else 255
    for row in pix:
        for p in row:
            if ct == 3:
                out += palette[p[0]]
                if trns is not None:
                    out.append(trns[p[0]] if p[0] < len(trns) else 255)
            elif ct in (0, 2):
                out += [v * 255 // top for v in p] if bd < 8 else list(p)
                if key is not None:
                    out.append(0 if p == key else amax)
            else:
                out += list(p)
    channels = len(out) // (w * h)
    with open(os.path.join(d, name + '.expected'), 'wb') as f:
        f.write(struct.pack('<%dH' % len(out), *out) if bd == 16 else bytes(out))
    return { 'name': name, 'file': os.path.join(d, name + '.png'), 'expected': os.path.join(d, name + '.expected'),
        'width': w, 'height': h, 'channels': channels, 'bitDepth': 16 if bd == 16 else 8 }

def photo(w, h, seed):
    rng = random.Random(seed)
    im = Image.new('RGB', (w, h))
    im.putdata([((x * 255) // max(1, w - 1), (y * 255) // max(1, h - 1), ((x + y) * 3) & 255) for y in range(h) for x in range(w)])
    if w >= 8 and h >= 8:
        dr = ImageDraw.Draw(im)
        dr.rectangle([w // 5, h // 5, w // 2, h // 2], fill=(255, 0, 0))
        dr.ellipse([w // 2, h // 3, w - 3, h - 3], fill=(0, 0, 255))
        dr.line([0, h - 1, w - 1, 0], fill=(0, 255, 0), width=3)
    for _ in range(w * h // 10):
        im.putpixel((rng.randrange(w), rng.randrange(h)), (rng.randrange(256), rng.randrange(256), rng.randrange(256)))
    return im

def gen(d):
    manifest = { 'synthetic': [], 'pillowPng': [], 'jpeg': [], 'zlib': [] }
    seed = 1
    combos = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }
    for ct, depths in combos.items():
        for bd in depths:
            for interlace in (0, 1):
                for use_trns in ((False, True) if ct in (0, 2, 3) else (False,)):
                    name = 'ct%d_bd%d_%s%s' % (ct, bd, 'adam7' if interlace else 'flat', '_trns' if use_trns else '')
                    e = synthetic_png(d, name, 37, 29, ct, bd, interlace, use_trns, seed)
                    e['pillow'] = write_ref(e['file'], e['expected'] + '.pil')
                    manifest['synthetic'].append(e)
                    seed += 1
    for (w, h) in ((1, 1), (2, 3), (5, 3), (9, 17)):
        for ct, bd in ((6, 8), (0, 1), (3, 4)):
            name = 'small_%dx%d_ct%d_bd%d' % (w, h, ct, bd)
            e = synthetic_png(d, name, w, h, ct, bd, 1, False, seed)
            e['pillow'] = write_ref(e['file'], e['expected'] + '.pil')
            manifest['synthetic'].append(e)
            seed += 1

    base = photo(61, 47, 7).convert('RGBA')
    base.putalpha(Image.linear_gradient('L').resize((61, 47)))
    variants = {
        'rgba': (base, {}),
        'rgb': (base.convert('RGB'), {}),
        'rgb_opt': (base.convert('RGB'), { 'optimize': True }),
        'rgb_level0': (base.convert('RGB'), { 'compress_level': 0 }),
        'rgb_level1': (base.convert('RGB'), { 'compress_level': 1 }),
        'l': (base.convert('L'), {}),
        'la': (base.convert('LA'), {}),
        'bilevel': (base.convert('1'), {}),
        'p': (base.convert('RGB').convert('P', palette=Image.ADAPTIVE, colors=50), {}),
        'p_trns': (base.convert('RGB').convert('P', palette=Image.ADAPTIVE, colors=50), { 'transparency': 3 }),
        'p_4bit': (base.convert('RGB').convert('P', palette=Image.ADAPTIVE, colors=16), { 'bits': 4 }),
        'l_trns': (base.convert('L'), { 'transparency': 128 }),
        'rgb_trns': (base.convert('RGB'), { 'transparency': (255, 0, 0) }),
    }
    i16 = Image.new('I;16', (61, 47))
    i16.putdata([(x * 1000 + y * 37) & 65535 for y in range(47) for x in range(61)])
    variants['gray16'] = (i16, {})
    for name, (im, opts) in variants.items():
        p = os.path.join(d, 'pil_' + name + '.png')
        im.save(p, **opts)
        manifest['pillowPng'].append({ 'name': name, 'file': p, 'pillow': write_ref(p, p + '.pil') })

    rgb = photo(203, 157, 3)
    jpegs = {}
    for ss, label in ((0, '444'), (1, '422'), (2, '420')):
        jpegs['base_' + label] = (rgb, { 'quality': 90, 'subsampling': ss })
        jpegs['prog_' + label] = (rgb, { 'quality': 90, 'subsampling': ss, 'progressive': True })
    jpegs['base_420_q30'] = (rgb, { 'quality': 30, 'subsampling': 2 })
    jpegs['prog_420_q100'] = (rgb, { 'quality': 100, 'subsampling': 2, 'progressive': True })
    jpegs['base_420_optimize'] = (rgb, { 'quality': 80, 'subsampling': 2, 'optimize': True })
    jpegs['gray'] = (rgb.convert('L'), { 'quality': 85 })
    jpegs['gray_prog'] = (rgb.convert('L'), { 'quality': 85, 'progressive': True })
    jpegs['cmyk'] = (rgb.convert('CMYK'), { 'quality': 90 })
    jpegs['cmyk_prog'] = (rgb.convert('CMYK'), { 'quality': 90, 'progressive': True })
    jpegs['restart_blocks'] = (rgb, { 'quality': 90, 'subsampling': 2, 'restart_marker_blocks': 5 })
    jpegs['restart_rows_prog'] = (rgb, { 'quality': 90, 'subsampling': 1, 'restart_marker_rows': 1, 'progressive': True })
    for (w, h) in ((1, 1), (7, 9), (17, 33)):
        jpegs['tiny_%dx%d' % (w, h)] = (photo(w, h, w), { 'quality': 90, 'subsampling': 2 })
        jpegs['tiny_prog_%dx%d' % (w, h)] = (photo(w, h, w), { 'quality': 90, 'subsampling': 1, 'progressive': True })
    for name, (im, opts) in jpegs.items():
        p = os.path.join(d, name + '.jpg')
        try:
            im.save(p, 'JPEG', **opts)
        except Exception as err:
            print('skip', name, err, file=sys.stderr)
            continue
        manifest['jpeg'].append({ 'name': name, 'file': p, 'pillow': write_ref(p, p + '.pil') })

    rng = random.Random(5)
    blobs = {
        'random': bytes(rng.randrange(256) for _ in range(70000)),
        'text': (open(__file__, 'rb').read() * 20),
        'runs': bytes([0] * 100000 + [1, 2, 3] * 30000),
        'empty': b'',
    }
    for name, data in blobs.items():
        orig = os.path.join(d, 'z_' + name + '.orig')
        with open(orig, 'wb') as f:
            f.write(data)
        for level in (0, 1, 6, 9):
            for raw in (False, True):
                co = zlib.compressobj(level, zlib.DEFLATED, -15 if raw else 15)
                z = co.compress(data) + co.flush()
                p = os.path.join(d, 'z_%s_%d%s' % (name, level, '.raw' if raw else '.z'))
                with open(p, 'wb') as f:
                    f.write(z)
                manifest['zlib'].append({ 'orig': orig, 'file': p, 'raw': raw })
        co = zlib.compressobj(6, zlib.DEFLATED, 15, 9, zlib.Z_FIXED)
        p = os.path.join(d, 'z_%s_fixed.z' % name)
        with open(p, 'wb') as f:
            f.write(co.compress(data) + co.flush())
        manifest['zlib'].append({ 'orig': orig, 'file': p, 'raw': False })

    with open(os.path.join(d, 'manifest.json'), 'w') as f:
        json.dump(manifest, f)

def ref(listfile, d):
    out = []
    for i, line in enumerate(open(listfile, encoding='utf-8').read().splitlines()):
        try:
            out.append(write_ref(line, os.path.join(d, 'ref_%d.bin' % i)))
        except Exception as err:
            out.append({ 'error': str(err) })
    print(json.dumps(out))

def zcheck(d):
    res = {}
    for name in sorted(os.listdir(d)):
        base, ext = os.path.splitext(name)
        if ext not in ('.z', '.raw') or not base.startswith('js_'):
            continue
        orig = open(os.path.join(d, base + '.orig'), 'rb').read()
        z = open(os.path.join(d, name), 'rb').read()
        try:
            res[name] = zlib.decompress(z, -15 if ext == '.raw' else 15) == orig
        except Exception as err:
            res[name] = str(err)
    print(json.dumps(res))

mode = sys.argv[1]
if mode == 'gen':
    gen(sys.argv[2])
elif mode == 'ref':
    ref(sys.argv[2], sys.argv[3])
elif mode == 'zcheck':
    zcheck(sys.argv[2])
`;

let tmp = null;
let oracle = null;
let manifest = null;

function python( ...args ) {

	const r = spawnSync( PYTHON, [ '-I', path.join( tmp, 'oracle.py' ), ...args ], { encoding: 'utf8', maxBuffer: 1 << 28 } );
	if ( r.status !== 0 ) throw new Error( `oracle ${ args[ 0 ] } failed: ${ r.stderr || r.error }` );
	return r.stdout;

}

before( () => {

	tmp = fs.mkdtempSync( path.join( os.tmpdir(), 'usd-gltf-image-' ) );
	fs.writeFileSync( path.join( tmp, 'oracle.py' ), ORACLE );
	const check = spawnSync( PYTHON, [ '-I', '-c', 'import PIL' ], { encoding: 'utf8' } );

	if ( check.status === 0 ) {

		oracle = true;
		python( 'gen', tmp );
		manifest = JSON.parse( fs.readFileSync( path.join( tmp, 'manifest.json' ), 'utf8' ) );

	}

} );

after( () => {

	if ( tmp ) fs.rmSync( tmp, { recursive: true, force: true } );

} );

function read( file ) {

	return new Uint8Array( fs.readFileSync( file ) );

}

// Reads a raw pixel dump; 16 bit dumps are little endian.
function readPixels( file, bitDepth ) {

	const bytes = read( file );
	return bitDepth === 16 ? new Uint16Array( bytes.buffer, bytes.byteOffset, bytes.length >> 1 ) : bytes;

}

function assertSamePixels( actual, expected, label, shift = 0 ) {

	assert.equal( actual.length, expected.length, `${ label }: sample count` );

	for ( let i = 0; i < actual.length; i ++ ) {

		if ( ( actual[ i ] >> shift ) !== expected[ i ] ) assert.fail( `${ label }: sample ${ i } is ${ actual[ i ] >> shift }, expected ${ expected[ i ] }` );

	}

}

function compareToPillow( image, ref, label ) {

	assert.equal( image.width, ref.width, `${ label }: width` );
	assert.equal( image.height, ref.height, `${ label }: height` );
	assert.equal( image.channels, ref.channels, `${ label }: channels` );

	if ( ref.msb ) {

		assert.equal( image.bitDepth, 16, `${ label }: bit depth` );
		assertSamePixels( image.data, readPixels( ref.file, 8 ), label, 8 );

	} else {

		assert.equal( image.bitDepth, ref.bitDepth, `${ label }: bit depth` );
		assertSamePixels( image.data, readPixels( ref.file, ref.bitDepth ), label );

	}

}

function jpegError( actual, expected ) {

	let sum = 0;
	let max = 0;

	for ( let i = 0; i < actual.length; i ++ ) {

		const d = Math.abs( actual[ i ] - expected[ i ] );
		sum += d;
		if ( d > max ) max = d;

	}

	return { mean: sum / actual.length, max };

}

function compareJPEG( image, ref, label ) {

	assert.equal( image.width, ref.width, `${ label }: width` );
	assert.equal( image.height, ref.height, `${ label }: height` );
	assert.equal( image.channels, ref.channels, `${ label }: channels` );
	const expected = read( ref.file );
	assert.equal( image.data.length, expected.length, `${ label }: sample count` );
	const err = jpegError( image.data, expected );
	assert.ok( err.mean < 2 && err.max < 16, `${ label }: mean error ${ err.mean.toFixed( 3 ) }, max ${ err.max }` );
	return err;

}

function randomBytes( n, seed ) {

	const out = new Uint8Array( n );
	let s = seed >>> 0 || 1;

	for ( let i = 0; i < n; i ++ ) {

		s ^= s << 13;
		s ^= s >>> 17;
		s ^= s << 5;
		out[ i ] = s;

	}

	return out;

}

function sameBytes( a, b ) {

	if ( a.length !== b.length ) return false;
	for ( let i = 0; i < a.length; i ++ ) if ( a[ i ] !== b[ i ] ) return false;
	return true;

}

// ---------------------------------------------------------------------------------------------
// DEFLATE

test( 'deflate -> inflate round trips at every level', () => {

	const text = new TextEncoder().encode( fs.readFileSync( fileURLToPath( import.meta.url ), 'utf8' ).repeat( 3 ) );
	const runs = new Uint8Array( 200000 );
	for ( let i = 0; i < runs.length; i ++ ) runs[ i ] = ( i / 1000 ) & 3;

	const inputs = {
		empty: new Uint8Array( 0 ),
		one: new Uint8Array( [ 42 ] ),
		random: randomBytes( 150000, 9 ),
		text,
		runs,
		zeros: new Uint8Array( 300000 ),
		mixed: new Uint8Array( [ ...randomBytes( 40000, 3 ), ...text.subarray( 0, 40000 ), ...new Uint8Array( 70000 ) ] ),
	};

	for ( const [ name, data ] of Object.entries( inputs ) ) {

		for ( let level = 0; level <= 9; level ++ ) {

			const raw = deflate( data, level );
			assert.ok( sameBytes( inflate( raw ), data ), `${ name } level ${ level } raw` );
			const z = deflateZlib( data, level );
			assert.ok( sameBytes( inflateZlib( z ), data ), `${ name } level ${ level } zlib` );
			assert.ok( sameBytes( inflateZlib( z, data.length ), data ), `${ name } level ${ level } with size hint` );

		}

	}

	// sensible compression
	assert.ok( deflate( text ).length < text.length / 4, 'text compresses' );
	assert.ok( deflate( inputs.zeros ).length < 1000, 'zeros compress' );
	assert.ok( deflate( inputs.random ).length < inputs.random.length + 100, 'random data barely expands' );

} );

test( 'inflate rejects corrupt data', () => {

	const z = deflateZlib( new TextEncoder().encode( 'hello hello hello hello hello world' ) );
	const bad = z.slice();
	bad[ bad.length - 1 ] ^= 1;
	assert.throws( () => inflateZlib( bad ), /adler32/ );
	assert.throws( () => inflateZlib( z.subarray( 0, 6 ) ), /invalid deflate data/ );
	assert.throws( () => inflate( new Uint8Array( [ 0xFF, 0xFF, 0xFF, 0xFF ] ) ), /invalid deflate data/ );
	assert.throws( () => inflateZlib( new Uint8Array( [ 0x78, 0x00, 0, 0 ] ) ), /zlib header/ );

} );

test( 'inflate reads Python zlib output', ( t ) => {

	if ( ! oracle ) return t.skip( 'Pillow / Python not available' );

	for ( const e of manifest.zlib ) {

		const orig = read( e.orig );
		const z = read( e.file );
		const out = e.raw ? inflate( z ) : inflateZlib( z );
		assert.ok( sameBytes( out, orig ), path.basename( e.file ) );

	}

} );

test( 'Python zlib reads deflate output', ( t ) => {

	if ( ! oracle ) return t.skip( 'Pillow / Python not available' );

	const dir = path.join( tmp, 'js-deflate' );
	fs.mkdirSync( dir );
	const text = new TextEncoder().encode( ORACLE.repeat( 10 ) );
	const inputs = { random: randomBytes( 100000, 4 ), text, empty: new Uint8Array( 0 ), runs: new Uint8Array( 100000 ).fill( 7 ) };

	for ( const [ name, data ] of Object.entries( inputs ) ) {

		for ( const level of [ 0, 1, 6, 9 ] ) {

			fs.writeFileSync( path.join( dir, `js_${ name }_${ level }.orig` ), data );
			fs.writeFileSync( path.join( dir, `js_${ name }_${ level }.z` ), deflateZlib( data, level ) );
			fs.writeFileSync( path.join( dir, `js_${ name }_${ level }r.orig` ), data );
			fs.writeFileSync( path.join( dir, `js_${ name }_${ level }r.raw` ), deflate( data, level ) );

		}

	}

	const results = JSON.parse( python( 'zcheck', dir ) );
	assert.equal( Object.keys( results ).length, 32 );
	for ( const [ name, ok ] of Object.entries( results ) ) assert.equal( ok, true, name );

} );

// ---------------------------------------------------------------------------------------------
// PNG

test( 'PNG: every color type, bit depth, interlace and filter matches the generator and Pillow', ( t ) => {

	if ( ! oracle ) return t.skip( 'Pillow / Python not available' );

	let pillowChecked = 0;

	for ( const e of manifest.synthetic ) {

		const image = decodePNG( read( e.file ) );
		assert.equal( image.width, e.width, e.name );
		assert.equal( image.height, e.height, e.name );
		assert.equal( image.channels, e.channels, e.name );
		assert.equal( image.bitDepth, e.bitDepth, e.name );
		assertSamePixels( image.data, readPixels( e.expected, e.bitDepth ), e.name );

		if ( e.pillow ) {

			compareToPillow( image, e.pillow, e.name + ' (Pillow)' );
			pillowChecked ++;

		}

	}

	assert.ok( manifest.synthetic.length >= 40 );
	assert.ok( pillowChecked >= 30, `Pillow compared ${ pillowChecked }` );

} );

test( 'PNG: files written by Pillow match Pillow', ( t ) => {

	if ( ! oracle ) return t.skip( 'Pillow / Python not available' );

	for ( const e of manifest.pillowPng ) {

		assert.ok( e.pillow, `${ e.name } has a reference` );
		compareToPillow( decodePNG( read( e.file ) ), e.pillow, e.name );

	}

} );

function testImage( width, height, channels, bitDepth ) {

	const data = bitDepth === 16 ? new Uint16Array( width * height * channels ) : new Uint8Array( width * height * channels );
	const noise = randomBytes( data.length, width * 31 + channels );

	for ( let y = 0, i = 0; y < height; y ++ ) {

		for ( let x = 0; x < width; x ++ ) {

			for ( let c = 0; c < channels; c ++, i ++ ) {

				const v = ( x * ( c + 1 ) * 3 + y * 5 + ( noise[ i ] & 7 ) ) & 255;
				data[ i ] = bitDepth === 16 ? ( v << 8 ) | noise[ i ] : v;

			}

		}

	}

	return { width, height, channels, bitDepth, data };

}

test( 'PNG: encodePNG -> decodePNG round trips', () => {

	for ( const bitDepth of [ 8, 16 ] ) {

		for ( let channels = 1; channels <= 4; channels ++ ) {

			for ( const [ w, h ] of [ [ 1, 1 ], [ 3, 7 ], [ 64, 33 ] ] ) {

				const image = testImage( w, h, channels, bitDepth );
				const back = decodePNG( encodePNG( image ) );
				assert.equal( back.width, w );
				assert.equal( back.height, h );
				assert.equal( back.channels, channels );
				assert.equal( back.bitDepth, bitDepth );
				assertSamePixels( back.data, image.data, `${ channels }ch ${ bitDepth }bit ${ w }x${ h }` );

			}

		}

	}

	// Uint8ClampedArray input and stored (level 0) output
	const clamped = testImage( 20, 10, 4, 8 );
	clamped.data = new Uint8ClampedArray( clamped.data );
	assertSamePixels( decodePNG( encodePNG( clamped, { level: 0 } ) ).data, clamped.data, 'clamped' );

} );

test( 'PNG: Pillow reads encodePNG output', ( t ) => {

	if ( ! oracle ) return t.skip( 'Pillow / Python not available' );

	const dir = path.join( tmp, 'js-png' );
	fs.mkdirSync( dir );
	const files = [];
	const images = [];

	for ( const bitDepth of [ 8, 16 ] ) {

		for ( let channels = 1; channels <= 4; channels ++ ) {

			const image = testImage( 45, 23, channels, bitDepth );
			const file = path.join( dir, `${ channels }_${ bitDepth }.png` );
			fs.writeFileSync( file, encodePNG( image ) );
			files.push( file );
			images.push( image );

		}

	}

	fs.writeFileSync( path.join( dir, 'list.txt' ), files.join( '\n' ) );
	const refs = JSON.parse( python( 'ref', path.join( dir, 'list.txt' ), dir ) );

	refs.forEach( ( ref, i ) => {

		assert.ok( ref && ! ref.error, `${ files[ i ] }: ${ ref && ref.error }` );
		compareToPillow( images[ i ], ref, path.basename( files[ i ] ) );

	} );

} );

test( 'PNG: errors', () => {

	const png = encodePNG( testImage( 16, 16, 3, 8 ) );
	assert.throws( () => decodePNG( new Uint8Array( 10 ) ), /not a PNG/ );
	assert.throws( () => decodePNG( png.subarray( 0, png.length - 40 ) ), /truncated|invalid deflate/ );
	assert.throws( () => encodePNG( { width: 2, height: 2, channels: 5, data: new Uint8Array( 20 ) } ), /channels/ );

} );

// ---------------------------------------------------------------------------------------------
// JPEG

test( 'JPEG: baseline, progressive, subsampling, grayscale, CMYK and restarts match Pillow', ( t ) => {

	if ( ! oracle ) return t.skip( 'Pillow / Python not available' );

	const names = manifest.jpeg.map( ( e ) => e.name );
	for ( const required of [ 'base_444', 'base_422', 'base_420', 'prog_444', 'prog_422', 'prog_420', 'gray', 'gray_prog', 'cmyk', 'cmyk_prog' ] ) {

		assert.ok( names.includes( required ), `fixture ${ required } exists` );

	}

	let worst = 0;

	for ( const e of manifest.jpeg ) {

		const image = decodeJPEG( read( e.file ) );
		const err = compareJPEG( image, e.pillow, e.name );
		worst = Math.max( worst, err.max );

	}

	t.diagnostic( `${ manifest.jpeg.length } JPEG fixtures, worst per-channel difference ${ worst }` );

} );

test( 'JPEG: unsupported variants throw clear errors', () => {

	// a minimal frame header with an arithmetic coding SOF marker
	const sof9 = new Uint8Array( [ 0xFF, 0xD8, 0xFF, 0xC9, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0, 0xFF, 0xD9 ] );
	assert.throws( () => decodeJPEG( sof9 ), /arithmetic/ );
	const sof3 = sof9.slice();
	sof3[ 3 ] = 0xC3;
	assert.throws( () => decodeJPEG( sof3 ), /lossless/ );
	assert.throws( () => decodeJPEG( new Uint8Array( [ 1, 2, 3 ] ) ), /not a JPEG/ );

} );

// ---------------------------------------------------------------------------------------------
// index

test( 'imageMimeType and decodeImage sniff the format', () => {

	const png = encodePNG( testImage( 4, 4, 2, 8 ) );
	assert.equal( imageMimeType( png ), 'image/png' );
	assert.equal( imageMimeType( new Uint8Array( [ 0xFF, 0xD8, 0xFF, 0xE0 ] ) ), 'image/jpeg' );
	assert.equal( imageMimeType( new TextEncoder().encode( 'RIFF\0\0\0\0WEBPVP8 ' ) ), 'image/webp' );
	assert.equal( imageMimeType( new Uint8Array( [ 0xAB, 0x4B, 0x54, 0x58, 0x20, 0x32, 0x30, 0xBB, 0x0D, 0x0A, 0x1A, 0x0A, 0 ] ) ), 'image/ktx2' );
	assert.equal( imageMimeType( new Uint8Array( [ 1, 2, 3 ] ) ), null );
	assert.equal( decodeImage( png.buffer, 'image/jpeg' ).channels, 2 );
	// a truncated WebP reaches the WebP decoder, which rejects it
	assert.throws( () => decodeImage( new TextEncoder().encode( 'RIFF\0\0\0\0WEBPVP8 ' ) ), /webp/ );
	assert.throws( () => decodeImage( new Uint8Array( [ 0xAB, 0x4B, 0x54, 0x58, 0x20, 0x32, 0x30, 0xBB, 0x0D, 0x0A, 0x1A, 0x0A, 0 ] ) ), /image\/ktx2/ );

} );

test( 'large 4096x4096 RGBA PNG timing', ( t ) => {

	const size = 4096;
	const data = new Uint8Array( size * size * 4 );
	const noise = randomBytes( size * 4, 77 );

	for ( let y = 0, i = 0; y < size; y ++ ) {

		for ( let x = 0; x < size; x ++, i += 4 ) {

			const n = noise[ ( x * 7 + y * 13 ) & ( size * 4 - 1 ) ];
			data[ i ] = ( x >> 4 ) + ( n & 3 );
			data[ i + 1 ] = ( y >> 4 ) + ( n & 7 );
			data[ i + 2 ] = ( ( x + y ) >> 5 ) ^ ( n & 1 );
			data[ i + 3 ] = 255;

		}

	}

	let start = performance.now();
	const png = encodePNG( { width: size, height: size, channels: 4, data } );
	const encodeMs = performance.now() - start;

	start = performance.now();
	const image = decodePNG( png );
	const decodeMs = performance.now() - start;

	assert.ok( sameBytes( image.data, data ) );
	t.diagnostic( `encodePNG ${ encodeMs.toFixed( 0 ) } ms (${ ( png.length / 1048576 ).toFixed( 1 ) } MB), decodePNG ${ decodeMs.toFixed( 0 ) } ms` );
	assert.ok( decodeMs < 3000, `decode took ${ decodeMs } ms` );
	assert.ok( encodeMs < 15000, `encode took ${ encodeMs } ms` );

} );

// ---------------------------------------------------------------------------------------------
// corpus

function corpusImages() {

	if ( ! fs.existsSync( CORPUS ) ) return [];
	const files = [];

	for ( const model of fs.readdirSync( CORPUS ) ) {

		const dir = path.join( CORPUS, model, 'glTF' );
		if ( ! fs.existsSync( dir ) ) continue;

		const walk = ( d ) => {

			for ( const entry of fs.readdirSync( d, { withFileTypes: true } ) ) {

				const p = path.join( d, entry.name );
				if ( entry.isDirectory() ) walk( p );
				else if ( /\.(png|jpe?g)$/i.test( entry.name ) ) files.push( p );

			}

		};

		walk( dir );

	}

	return files.sort();

}

test( 'corpus: every Khronos sample texture decodes, a sample matches Pillow', ( t ) => {

	const files = corpusImages();
	if ( files.length === 0 ) return t.skip( 'corpus not downloaded' );

	const results = [];
	let totalMs = 0;

	for ( const file of files ) {

		const bytes = read( file );
		const start = performance.now();
		let image;

		try {

			image = decodeImage( bytes );

		} catch ( err ) {

			assert.fail( `${ path.relative( CORPUS, file ) }: ${ err.message }` );

		}

		const ms = performance.now() - start;
		totalMs += ms;
		assert.equal( image.data.length, image.width * image.height * image.channels );
		results.push( { file, ms, bytes: bytes.length, image: { width: image.width, height: image.height, channels: image.channels, type: imageMimeType( bytes ) } } );

	}

	const slowest = results.reduce( ( a, b ) => ( b.ms > a.ms ? b : a ) );
	const largest = results.reduce( ( a, b ) => ( b.image.width * b.image.height > a.image.width * a.image.height ? b : a ) );
	t.diagnostic( `${ files.length } images decoded in ${ ( totalMs / 1000 ).toFixed( 1 ) } s` );
	t.diagnostic( `largest ${ path.relative( CORPUS, largest.file ) } ${ largest.image.width }x${ largest.image.height } ${ largest.image.type } ${ largest.ms.toFixed( 0 ) } ms` );
	t.diagnostic( `slowest ${ path.relative( CORPUS, slowest.file ) } ${ slowest.image.width }x${ slowest.image.height } ${ slowest.image.type } ${ slowest.ms.toFixed( 0 ) } ms` );

	if ( ! oracle ) return;

	// compare a spread of files (plus the largest and slowest) against Pillow
	const step = Math.max( 1, Math.ceil( files.length / 60 ) );
	const sample = [ ...new Set( [ ...files.filter( ( f, i ) => i % step === 0 ), largest.file, slowest.file ] ) ];
	const dir = path.join( tmp, 'corpus' );
	fs.mkdirSync( dir );
	fs.writeFileSync( path.join( dir, 'list.txt' ), sample.join( '\n' ) );
	const refs = JSON.parse( python( 'ref', path.join( dir, 'list.txt' ), dir ) );
	let compared = 0;
	let worstJPEG = { mean: 0, max: 0 };

	sample.forEach( ( file, i ) => {

		const ref = refs[ i ];
		const label = path.relative( CORPUS, file );
		if ( ref === null ) return; // Pillow has no faithful 8 bit view of this file
		assert.ok( ! ref.error, `${ label }: Pillow ${ ref.error }` );

		const bytes = read( file );
		const image = decodeImage( bytes );

		if ( imageMimeType( bytes ) === 'image/jpeg' ) {

			const err = compareJPEG( image, ref, label );
			worstJPEG = { mean: Math.max( worstJPEG.mean, err.mean ), max: Math.max( worstJPEG.max, err.max ) };

		} else {

			compareToPillow( image, ref, label );

		}

		compared ++;
		fs.rmSync( ref.file );

	} );

	t.diagnostic( `${ compared } of ${ sample.length } sampled images compared with Pillow; worst JPEG mean error ${ worstJPEG.mean.toFixed( 3 ) }, max ${ worstJPEG.max }` );

} );
