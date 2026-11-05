import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const worker = new Worker( new URL( './worker.js', import.meta.url ), { type: 'module' } );

const drop = document.getElementById( 'drop' );
const input = document.getElementById( 'file' );
const status = document.getElementById( 'status' );
const actions = document.getElementById( 'actions' );
const logBox = document.getElementById( 'log' );
const hint = document.getElementById( 'hint' );
const caption = document.getElementById( 'caption' );
const controlsBar = document.getElementById( 'viewer-controls' );
const animationSelect = document.getElementById( 'animation' );
const variantLabel = document.getElementById( 'variant-label' );
const variantSelect = document.getElementById( 'variant' );

const MAIN = /\.(usdz|usda|usdc|usd|glb|gltf)$/i;
const isIOS = /iPad|iPhone|iPod/.test( navigator.userAgent ) || ( navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1 );

// --- viewer ---

const container = document.getElementById( 'viewer' );
const renderer = new THREE.WebGLRenderer( { antialias: true, alpha: true } );
renderer.setPixelRatio( Math.min( devicePixelRatio, 2 ) );
renderer.toneMapping = THREE.NeutralToneMapping;
container.prepend( renderer.domElement );

const scene = new THREE.Scene();
scene.environment = new THREE.PMREMGenerator( renderer ).fromScene( new RoomEnvironment(), 0.04 ).texture;
const camera = new THREE.PerspectiveCamera( 40, 1, 0.01, 1000 );
const controls = new OrbitControls( camera, renderer.domElement );
controls.enableDamping = true;
const clock = new THREE.Clock();
let model = null, mixer = null, gltf = null;

function resize() {

	const { width, height } = container.getBoundingClientRect();
	renderer.setSize( width, height, false );
	camera.aspect = width / height;
	camera.updateProjectionMatrix();

}

new ResizeObserver( resize ).observe( container );

renderer.setAnimationLoop( () => {

	mixer?.update( clock.getDelta() );
	controls.update();
	renderer.render( scene, camera );

} );

async function show( glb, label ) {

	if ( model ) {

		scene.remove( model );
		model.traverse( ( o ) => { o.geometry?.dispose(); [].concat( o.material || [] ).forEach( ( m ) => m.dispose() ); } );

	}

	gltf = await new GLTFLoader().parseAsync( glb.buffer.slice( glb.byteOffset, glb.byteOffset + glb.byteLength ), '' );
	model = gltf.scene;
	scene.add( model );

	// frame the model
	const box = new THREE.Box3().setFromObject( model );
	const size = box.getSize( new THREE.Vector3() ).length() || 1;
	const center = box.getCenter( new THREE.Vector3() );
	controls.target.copy( center );
	camera.near = size / 100;
	camera.far = size * 100;
	camera.position.copy( center ).add( new THREE.Vector3( 0.6, 0.35, 1 ).normalize().multiplyScalar( size * 1.1 ) );
	camera.updateProjectionMatrix();

	// animations
	mixer = gltf.animations.length ? new THREE.AnimationMixer( model ) : null;
	animationSelect.replaceChildren( ...[ 'None', ...gltf.animations.map( ( a, i ) => a.name || `Animation ${ i + 1 }` ) ].map( ( name, i ) => new Option( name, i - 1 ) ) );
	if ( mixer ) { animationSelect.value = '0'; play( 0 ); }

	// KHR_materials_variants
	const variants = gltf.parser.json.extensions?.KHR_materials_variants?.variants || [];
	variantLabel.hidden = ! variants.length;
	variantSelect.replaceChildren( ...variants.map( ( v, i ) => new Option( v.name, i ) ) );

	controlsBar.hidden = ! mixer && ! variants.length;
	hint.hidden = true;
	caption.textContent = label;

}

function play( index ) {

	mixer?.stopAllAction();
	if ( index >= 0 ) mixer.clipAction( gltf.animations[ index ] ).play();

}

animationSelect.onchange = () => play( + animationSelect.value );

variantSelect.onchange = async () => {

	const index = + variantSelect.value;
	const parser = gltf.parser;

	for ( const object of model.getObjectsByProperty( 'isMesh', true ) ) {

		const meshDef = parser.json.meshes[ parser.associations.get( object )?.meshes ];
		const primitive = meshDef?.primitives[ parser.associations.get( object ).primitives ];
		const mapping = primitive?.extensions?.KHR_materials_variants?.mappings.find( ( m ) => m.variants.includes( index ) );
		if ( mapping ) object.material = await parser.getDependency( 'material', mapping.material );

	}

};

// --- conversion ---

function setStatus( text, error = false ) {

	status.textContent = text;
	status.classList.toggle( 'error', error );

}

function download( bytes, name, mime, primary ) {

	const url = URL.createObjectURL( new Blob( [ bytes ], { type: mime } ) );
	const a = Object.assign( document.createElement( 'a' ), { href: url, download: name, className: 'button' + ( primary ? ' primary' : '' ), textContent: `Download ${ name }` } );
	actions.append( a );
	return url;

}

async function convert( files ) {

	const main = files.find( ( f ) => MAIN.test( f.path ) );
	if ( ! main ) return setStatus( 'Drop a .usdz, .usda, .usdc, .usd, .glb or .gltf file.', true );

	actions.replaceChildren();
	logBox.hidden = true;
	setStatus( `Converting ${ main.path.split( '/' ).pop() }…` );

	worker.postMessage( { files, main } );

	const result = await new Promise( ( resolve ) => { worker.onmessage = ( e ) => resolve( e.data ); } );

	const notes = [ ...new Set( result.logs ) ];
	logBox.hidden = ! notes.length;
	logBox.querySelector( 'ul' ).replaceChildren( ...notes.map( ( n ) => Object.assign( document.createElement( 'li' ), { textContent: n } ) ) );

	if ( result.error ) return setStatus( result.error, true );

	const toUSD = result.outputName.endsWith( '.usdz' );
	const mb = ( result.output.byteLength / 1e6 ).toFixed( 1 );
	setStatus( `Converted ${ result.from } → ${ toUSD ? 'usdz' : 'glb' } in ${ Math.round( result.ms ) } ms (${ mb } MB).` );

	const url = download( result.output, result.outputName, toUSD ? 'model/vnd.usdz+zip' : 'model/gltf-binary', true );

	if ( toUSD && isIOS ) {

		// AR Quick Look needs an <a rel="ar"> wrapping an image
		const ar = Object.assign( document.createElement( 'a' ), { href: url, rel: 'ar', className: 'button' } );
		ar.append( Object.assign( document.createElement( 'img' ), { alt: '', width: 1, height: 1 } ), 'View in AR' );
		actions.append( ar );

	}

	try {

		await show( result.preview, toUSD ? 'Preview: the USDZ read back to glTF' : 'Preview: the converted GLB' );

	} catch ( e ) {

		setStatus( `${ status.textContent } Preview failed: ${ e.message }`, true );

	}

}

async function readEntries( items ) {

	// folders dropped in browsers that support entries
	const out = [];

	async function walk( entry, prefix ) {

		if ( entry.isFile ) {

			const file = await new Promise( ( res, rej ) => entry.file( res, rej ) );
			out.push( { path: prefix + file.name, bytes: new Uint8Array( await file.arrayBuffer() ) } );

		} else if ( entry.isDirectory ) {

			const reader = entry.createReader();
			let batch;
			while ( ( batch = await new Promise( ( res ) => reader.readEntries( res ) ) ).length ) for ( const e of batch ) await walk( e, prefix + entry.name + '/' );

		}

	}

	for ( const entry of items ) if ( entry ) await walk( entry, '' );
	return out;

}

async function fromFileList( list ) {

	return Promise.all( [ ...list ].map( async ( file ) => ( { path: file.webkitRelativePath || file.name, bytes: new Uint8Array( await file.arrayBuffer() ) } ) ) );

}

drop.addEventListener( 'dragover', ( e ) => { e.preventDefault(); drop.classList.add( 'over' ); } );
drop.addEventListener( 'dragleave', () => drop.classList.remove( 'over' ) );
drop.addEventListener( 'drop', async ( e ) => {

	e.preventDefault();
	drop.classList.remove( 'over' );
	const entries = [ ...e.dataTransfer.items ].map( ( i ) => i.webkitGetAsEntry?.() );
	const files = entries.some( Boolean ) ? await readEntries( entries ) : await fromFileList( e.dataTransfer.files );
	convert( files );

} );

input.addEventListener( 'change', async () => convert( await fromFileList( input.files ) ) );

for ( const button of document.querySelectorAll( '[data-sample]' ) ) {

	button.addEventListener( 'click', async () => {

		const url = button.dataset.sample;
		setStatus( `Downloading ${ button.textContent }…` );

		try {

			const response = await fetch( url );
			if ( ! response.ok ) throw new Error( `${ response.status } ${ response.statusText }` );
			convert( [ { path: url.split( '/' ).pop(), bytes: new Uint8Array( await response.arrayBuffer() ) } ] );

		} catch ( e ) {

			setStatus( `Could not download the sample: ${ e.message }`, true );

		}

	} );

}
