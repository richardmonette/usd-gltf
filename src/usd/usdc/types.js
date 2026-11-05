// Crate value type enum (pxr/usd/sdf/crateDataTypes.h), spec types and half floats.

export const TYPE = {
	Invalid: 0, Bool: 1, UChar: 2, Int: 3, UInt: 4, Int64: 5, UInt64: 6, Half: 7, Float: 8, Double: 9,
	String: 10, Token: 11, AssetPath: 12, Matrix2d: 13, Matrix3d: 14, Matrix4d: 15, Quatd: 16, Quatf: 17, Quath: 18,
	Vec2d: 19, Vec2f: 20, Vec2h: 21, Vec2i: 22, Vec3d: 23, Vec3f: 24, Vec3h: 25, Vec3i: 26, Vec4d: 27, Vec4f: 28, Vec4h: 29, Vec4i: 30,
	Dictionary: 31, TokenListOp: 32, StringListOp: 33, PathListOp: 34, ReferenceListOp: 35, IntListOp: 36, Int64ListOp: 37,
	UIntListOp: 38, UInt64ListOp: 39, PathVector: 40, TokenVector: 41, Specifier: 42, Permission: 43, Variability: 44,
	VariantSelectionMap: 45, TimeSamples: 46, Payload: 47, DoubleVector: 48, LayerOffsetVector: 49, StringVector: 50,
	ValueBlock: 51, Value: 52, UnregisteredValue: 53, UnregisteredValueListOp: 54, PayloadListOp: 55, TimeCode: 56,
	PathExpression: 57, Relocates: 58, Spline: 59, AnimationBlock: 60, Duration: 61
};

export const TYPE_NAMES = Object.fromEntries( Object.entries( TYPE ).map( ( [ k, v ] ) => [ v, k ] ) );

export const SPEC = {
	Unknown: 0, Attribute: 1, Connection: 2, Expression: 3, Mapper: 4, MapperArg: 5, Prim: 6, PseudoRoot: 7,
	Relationship: 8, RelationshipTarget: 9, Variant: 10, VariantSet: 11
};

export const SPECIFIERS = [ 'def', 'over', 'class' ];
export const PERMISSIONS = [ 'public', 'private' ];

// Plain numeric types: [ scalar kind, component count, USD type name ].
// Scalar kinds: b bool, u8, i32, u32, i64, u64, f16, f32, f64.
export const POD = [];
POD[ TYPE.Bool ] = [ 'b', 1, 'bool' ];
POD[ TYPE.UChar ] = [ 'u8', 1, 'uchar' ];
POD[ TYPE.Int ] = [ 'i32', 1, 'int' ];
POD[ TYPE.UInt ] = [ 'u32', 1, 'uint' ];
POD[ TYPE.Int64 ] = [ 'i64', 1, 'int64' ];
POD[ TYPE.UInt64 ] = [ 'u64', 1, 'uint64' ];
POD[ TYPE.Half ] = [ 'f16', 1, 'half' ];
POD[ TYPE.Float ] = [ 'f32', 1, 'float' ];
POD[ TYPE.Double ] = [ 'f64', 1, 'double' ];
POD[ TYPE.TimeCode ] = [ 'f64', 1, 'timecode' ];
POD[ TYPE.Duration ] = [ 'f64', 1, 'duration' ];
POD[ TYPE.Matrix2d ] = [ 'f64', 4, 'matrix2d' ];
POD[ TYPE.Matrix3d ] = [ 'f64', 9, 'matrix3d' ];
POD[ TYPE.Matrix4d ] = [ 'f64', 16, 'matrix4d' ];
POD[ TYPE.Quatd ] = [ 'f64', 4, 'quatd' ];
POD[ TYPE.Quatf ] = [ 'f32', 4, 'quatf' ];
POD[ TYPE.Quath ] = [ 'f16', 4, 'quath' ];

for ( const n of [ 2, 3, 4 ] ) {

	POD[ TYPE[ `Vec${ n }d` ] ] = [ 'f64', n, `double${ n }` ];
	POD[ TYPE[ `Vec${ n }f` ] ] = [ 'f32', n, `float${ n }` ];
	POD[ TYPE[ `Vec${ n }h` ] ] = [ 'f16', n, `half${ n }` ];
	POD[ TYPE[ `Vec${ n }i` ] ] = [ 'i32', n, `int${ n }` ];

}

export const SCALAR_SIZE = { b: 1, u8: 1, i32: 4, u32: 4, i64: 8, u64: 8, f16: 2, f32: 4, f64: 8 };

export const isVecType = ( t ) => t >= TYPE.Vec2d && t <= TYPE.Vec4i;
export const isMatrixType = ( t ) => t >= TYPE.Matrix2d && t <= TYPE.Matrix4d;

const ROLE = /^(?:point|normal|vector|color|texCoord)([234])([dfh])$/;
const VEC = /^(double|float|half|int)([234])$/;
const VEC_SUFFIX = { double: 'd', float: 'f', half: 'h', int: 'i' };

const SIMPLE = {
	bool: TYPE.Bool, uchar: TYPE.UChar, int: TYPE.Int, uint: TYPE.UInt, int64: TYPE.Int64, uint64: TYPE.UInt64,
	half: TYPE.Half, float: TYPE.Float, double: TYPE.Double, timecode: TYPE.TimeCode, string: TYPE.String,
	token: TYPE.Token, asset: TYPE.AssetPath, matrix2d: TYPE.Matrix2d, matrix3d: TYPE.Matrix3d, matrix4d: TYPE.Matrix4d,
	frame4d: TYPE.Matrix4d, quatd: TYPE.Quatd, quatf: TYPE.Quatf, quath: TYPE.Quath, pathExpression: TYPE.PathExpression,
	dictionary: TYPE.Dictionary, duration: TYPE.Duration
};

/**
 * Crate type for a USD value type name without the [] suffix, e.g. 'color3f' -> TYPE.Vec3f.
 * @returns {number} or -1 when unknown
 */
export function crateTypeFor( base ) {

	if ( base in SIMPLE ) return SIMPLE[ base ];

	let m = ROLE.exec( base );
	if ( m ) return TYPE[ `Vec${ m[ 1 ] }${ m[ 2 ] }` ];

	m = VEC.exec( base );
	if ( m ) return TYPE[ `Vec${ m[ 2 ] }${ VEC_SUFFIX[ m[ 1 ] ] }` ];

	return - 1;

}

// Half floats.

let halfTable = null;

function buildHalfTable() {

	halfTable = new Float32Array( 65536 );

	for ( let h = 0; h < 65536; h ++ ) {

		const s = h & 0x8000 ? - 1 : 1;
		const e = ( h >>> 10 ) & 31;
		const m = h & 1023;

		if ( e === 0 ) halfTable[ h ] = s * m * 2 ** - 24;
		else if ( e === 31 ) halfTable[ h ] = m ? NaN : s * Infinity;
		else halfTable[ h ] = s * ( 1024 + m ) * 2 ** ( e - 25 );

	}

}

export function halfToFloat( h ) {

	if ( halfTable === null ) buildHalfTable();
	return halfTable[ h & 0xffff ];

}

export function halfArrayToFloat32( u16 ) {

	if ( halfTable === null ) buildHalfTable();
	const out = new Float32Array( u16.length );
	for ( let i = 0; i < u16.length; i ++ ) out[ i ] = halfTable[ u16[ i ] ];
	return out;

}

const F32 = new Float32Array( 1 );
const U32 = new Uint32Array( F32.buffer );

// Round to nearest even, like GfHalf.
export function floatToHalf( v ) {

	F32[ 0 ] = v;
	const x = U32[ 0 ];
	const sign = ( x >>> 16 ) & 0x8000;
	const exp = ( x >>> 23 ) & 255;
	let mant = x & 0x7fffff;

	if ( exp === 255 ) return sign | 0x7c00 | ( mant ? 0x200 : 0 );

	const e = exp - 112;
	if ( e >= 31 ) return sign | 0x7c00;

	if ( e <= 0 ) {

		if ( e < - 10 ) return sign;
		mant |= 0x800000;
		const shift = 14 - e;
		let h = mant >>> shift;
		const rem = mant & ( ( 1 << shift ) - 1 );
		const half = 1 << ( shift - 1 );
		if ( rem > half || ( rem === half && ( h & 1 ) ) ) h ++;
		return sign | h;

	}

	let h = ( e << 10 ) | ( mant >>> 13 );
	const rem = mant & 0x1fff;
	if ( rem > 0x1000 || ( rem === 0x1000 && ( h & 1 ) ) ) h ++;
	return sign | h;

}
