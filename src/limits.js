// Opt-in resource limits for a conversion: decoded data, serialized output and cancellation.

/**
 * Thrown when a conversion would go over one of its limits. The message and fields describe sizes
 * only, never input data or file names.
 */
export class ConversionLimitError extends Error {

	/**
	 * @param {{ stage: string, resource: 'decoded'|'output', limit: number, attempted: number }} info
	 */
	constructor( { stage, resource, limit, attempted } ) {

		super( `usd-gltf: ${ stage } needs ${ attempted } ${ resource } bytes, over the limit of ${ limit }` );
		this.name = 'ConversionLimitError';
		this.code = 'USD_GLTF_LIMIT';
		this.stage = stage;
		this.resource = resource;
		this.limit = limit;
		this.attempted = attempted;

	}

}

/**
 * Tracks one conversion against its limits. Readers and converters charge decoded bytes before
 * allocating them; writers report their size before growing.
 */
export class Budget {

	/**
	 * @param {{ maxDecodedBytes?: number, maxOutputBytes?: number, signal?: AbortSignal }} [options]
	 */
	constructor( { maxDecodedBytes = Infinity, maxOutputBytes = Infinity, signal = null } = {} ) {

		this.maxDecodedBytes = maxDecodedBytes;
		this.maxOutputBytes = maxOutputBytes;
		this.signal = signal;
		this.decodedBytes = 0;

	}

	/**
	 * Adds to the running total of decoded data: accessors, arrays, decompressed sections and images.
	 * @param {number} bytes
	 * @param {string} stage
	 */
	decode( bytes, stage ) {

		checkSize( bytes, stage );
		this.check();
		this.decodedBytes += bytes;
		if ( this.decodedBytes > this.maxDecodedBytes ) throw new ConversionLimitError( { stage, resource: 'decoded', limit: this.maxDecodedBytes, attempted: this.decodedBytes } );

	}

	/**
	 * Checks the size an output buffer is about to reach.
	 * @param {number} bytes
	 * @param {string} stage
	 */
	output( bytes, stage ) {

		checkSize( bytes, stage );
		if ( bytes > this.maxOutputBytes ) throw new ConversionLimitError( { stage, resource: 'output', limit: this.maxOutputBytes, attempted: bytes } );

	}

	// Throws the signal's reason once the conversion is cancelled.
	check() {

		this.signal?.throwIfAborted();

	}

}

/**
 * A size computed from counts in a file must be a whole number of bytes that fits in an array.
 * @param {number} bytes
 * @param {string} stage
 */
export function checkSize( bytes, stage ) {

	if ( ! Number.isSafeInteger( bytes ) || bytes < 0 ) throw new Error( `usd-gltf: invalid size in ${ stage }` );

}

/**
 * For catch blocks that skip one failed asset and carry on: rethrows what must end the whole
 * conversion instead, a limit error or cancellation.
 * @param {unknown} error
 * @param {Budget} [budget]
 */
export function rethrowFatal( error, budget ) {

	budget?.check();
	if ( error instanceof ConversionLimitError ) throw error;

}
