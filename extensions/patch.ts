/**
 * Patch ownership registry. A patch is stored on `globalThis` under a `Symbol.for` key so a module
 * re-created by /reload can find and cleanly replace the previous module's patch instead of
 * stacking on top of it.
 */
export class PatchRegistry {
	private readonly host: Record<PropertyKey, unknown>;

	constructor(host: Record<PropertyKey, unknown> = globalThis as Record<PropertyKey, unknown>) {
		this.host = host;
	}

	get<T = unknown>(key: symbol): T | undefined {
		return this.host[key] as T | undefined;
	}

	owns(key: symbol, value: unknown): boolean {
		return this.host[key] === value;
	}

	/** Overwrite and return the replaced value; the caller decides how to inactivate it. */
	install<T = unknown>(key: symbol, value: T): T | undefined {
		const previous = this.host[key] as T | undefined;
		this.host[key] = value;
		return previous;
	}
}

export const patchRegistry = new PatchRegistry();
