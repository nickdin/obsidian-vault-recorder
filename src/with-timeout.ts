/**
 * Give up on a call that has not finished within `ms`. The call itself is not
 * cancelled (a promise cannot be); its late answer is ignored. Used for the
 * service send, whose `requestUrl` has no timeout of its own: a hung connection
 * would otherwise hold its note's send open until Obsidian reloads.
 */
export function withTimeout<T>(call: Promise<T>, ms: number, what: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${what} gave no answer in ${ms} ms`)), ms);
		call.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(err) => {
				clearTimeout(timer);
				reject(err instanceof Error ? err : new Error(String(err)));
			},
		);
	});
}
