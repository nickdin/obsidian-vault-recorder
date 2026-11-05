import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
	MODEL_LIST,
	downloadAddress,
	findModel,
	formatSize,
	totalBytes,
	type ModelEntry,
} from "./model-list.js";
import {
	ModelDownloadError,
	ModelStore,
	downloadButtonLabel,
	type DownloadProgress,
} from "./model-store.js";
import { FakeModelDisk, FakeNetwork } from "./model-store-fakes.js";

const KB_TINY = findModel("kb-whisper-tiny") as ModelEntry;
const KB_BASE = findModel("kb-whisper-base") as ModelEntry;
const FOLDER = "vault-recorder/models";

function makeStore(overrides: { chunkBytes?: number; modelFolder?: () => string } = {}) {
	const disk = new FakeModelDisk();
	const network = new FakeNetwork();
	const store = new ModelStore({
		modelFolder: overrides.modelFolder ?? (() => FOLDER),
		folder: disk,
		trash: disk,
		download: network,
		chunkBytes: overrides.chunkBytes ?? 40_000_000,
	});
	return { disk, network, store };
}

describe("the model list", () => {
	it("has the four models, each pinned to a full revision with every file's size", () => {
		assert.deepEqual(
			MODEL_LIST.map((entry) => entry.id),
			["kb-whisper-tiny", "kb-whisper-base", "whisper-tiny", "whisper-base"],
		);
		for (const entry of MODEL_LIST) {
			assert.match(entry.revision, /^[0-9a-f]{40}$/, `${entry.id} is pinned to a full commit`);
			assert.ok(entry.files.length > 0);
			for (const file of entry.files) {
				assert.ok(Number.isInteger(file.bytes) && file.bytes > 0, `${entry.id}/${file.path} has a size`);
			}
		}
	});

	it("marks one model recommended in each language group, and the base one", () => {
		const recommended = MODEL_LIST.filter((entry) => entry.recommended).map((entry) => entry.id);
		assert.deepEqual(recommended, ["kb-whisper-base", "whisper-base"]);
		assert.deepEqual(
			MODEL_LIST.filter((entry) => entry.language === "sv").map((entry) => entry.id),
			["kb-whisper-tiny", "kb-whisper-base"],
		);
	});

	it("asks for the files transformers.js loads for the quantized model, and no others", () => {
		for (const entry of MODEL_LIST) {
			assert.deepEqual(
				entry.files.map((file) => file.path),
				[
					"config.json",
					"generation_config.json",
					"preprocessor_config.json",
					"tokenizer.json",
					"tokenizer_config.json",
					"onnx/encoder_model_quantized.onnx",
					"onnx/decoder_model_merged_quantized.onnx",
				],
			);
		}
	});

	it("addresses a file on Hugging Face at the pinned revision", () => {
		const file = KB_TINY.files[0];
		assert.equal(
			downloadAddress(KB_TINY, file),
			"https://huggingface.co/KBLab/kb-whisper-tiny/resolve/76d796af43a50fa34321efa562c9b9887a187463/config.json",
		);
	});

	it("reads the total size in decimal megabytes on the button", () => {
		assert.equal(formatSize(182_400_000), "182 MB");
		assert.equal(downloadButtonLabel(KB_TINY), `Download ${Math.round(totalBytes(KB_TINY) / 1_000_000)} MB`);
		assert.equal(downloadButtonLabel(KB_TINY), "Download 124 MB");
	});
});

describe("presence", () => {
	it("is present when every file is there at its listed size", async () => {
		const { disk, store } = makeStore();
		disk.place(KB_TINY);
		const status = await store.status(KB_TINY);
		assert.equal(status.present, true);
		assert.deepEqual(status.missing, []);
		assert.equal(await store.refreshOne("kb-whisper-tiny"), true);
		assert.equal(store.isPresent("kb-whisper-tiny"), true);
	});

	it("is absent when one file is a single byte short", async () => {
		const { disk, store } = makeStore();
		disk.place(KB_TINY);
		const decoder = `${FOLDER}/kb-whisper-tiny/onnx/decoder_model_merged_quantized.onnx`;
		disk.files.set(decoder, (disk.files.get(decoder) as number) - 1);
		const status = await store.status(KB_TINY);
		assert.equal(status.present, false);
		assert.deepEqual(
			status.missing.map((file) => file.path),
			["onnx/decoder_model_merged_quantized.onnx"],
		);
		assert.equal(await store.refreshOne("kb-whisper-tiny"), false);
		assert.equal(store.isPresent("kb-whisper-tiny"), false);
	});

	it("is absent when one file is a byte too long, or one file is missing", async () => {
		const { disk, store } = makeStore();
		disk.place(KB_TINY);
		const config = `${FOLDER}/kb-whisper-tiny/config.json`;
		disk.files.set(config, (disk.files.get(config) as number) + 1);
		assert.equal((await store.status(KB_TINY)).present, false);
		disk.files.set(config, KB_TINY.files[0].bytes);
		disk.files.delete(`${FOLDER}/kb-whisper-tiny/tokenizer.json`);
		assert.equal((await store.status(KB_TINY)).present, false);
	});

	it("counts one model's files for that model only", async () => {
		const { disk, store } = makeStore();
		disk.place(KB_BASE);
		assert.equal((await store.status(KB_TINY)).present, false);
		assert.equal((await store.status(KB_BASE)).present, true);
	});

	it("follows the model folder setting as it is now, and the top of the vault when it is empty", async () => {
		let folder = "vault-recorder/models";
		const { disk, store } = makeStore({ modelFolder: () => folder });
		disk.place(KB_TINY, "elsewhere");
		assert.equal((await store.status(KB_TINY)).present, false);
		folder = "/elsewhere/";
		assert.equal((await store.status(KB_TINY)).present, true);
		folder = "";
		for (const file of KB_BASE.files) disk.files.set(`${KB_BASE.id}/${file.path}`, file.bytes);
		assert.equal((await store.status(KB_BASE)).present, true);
	});

	it("knows nothing about an id that is not on the list", async () => {
		const { store } = makeStore();
		assert.equal(await store.refreshOne("not-a-model"), false);
		assert.equal(store.isPresent("not-a-model"), false);
	});
});

describe("download", () => {
	it("fetches every file from Hugging Face at the pinned revision and ends present at full size", async () => {
		const { disk, network, store } = makeStore();
		await store.download(KB_TINY);

		assert.equal((await store.status(KB_TINY)).present, true);
		for (const file of KB_TINY.files) {
			assert.equal(disk.files.get(`${FOLDER}/kb-whisper-tiny/${file.path}`), file.bytes, file.path);
		}
		assert.deepEqual(
			[...disk.files.keys()].filter((path) => path.endsWith(".part")),
			[],
			"no half-finished file is left",
		);
		for (const { url } of network.asked) {
			assert.ok(
				url.startsWith(`https://huggingface.co/KBLab/kb-whisper-tiny/resolve/${KB_TINY.revision}/`),
				url,
			);
		}
		assert.deepEqual(
			[...new Set(network.asked.map((asked) => asked.url))],
			KB_TINY.files.map((file) => downloadAddress(KB_TINY, file)),
		);
	});

	it("asks for a file in ranges no larger than the chunk, covering it exactly once", async () => {
		const { network, store } = makeStore({ chunkBytes: 40_000_000 });
		await store.download(KB_TINY);
		const decoder = KB_TINY.files[6];
		const ranges = network.asked
			.filter((asked) => asked.url.endsWith(decoder.path))
			.map(({ start, end }) => [start, end]);
		assert.deepEqual(ranges, [
			[0, 39_999_999],
			[40_000_000, 79_999_999],
			[80_000_000, decoder.bytes - 1],
		]);
	});

	it("reports progress up to the full size, and tells listeners when it ends", async () => {
		const { store } = makeStore();
		const seen: (DownloadProgress | null)[] = [];
		store.onProgress("kb-whisper-tiny", (progress) => seen.push(progress));
		await store.download(KB_TINY);
		const real = seen.filter((progress): progress is DownloadProgress => progress !== null);
		assert.ok(real.length >= KB_TINY.files.length);
		assert.deepEqual(real[real.length - 1], { doneBytes: totalBytes(KB_TINY), totalBytes: totalBytes(KB_TINY) });
		assert.equal(seen[seen.length - 1], null);
		assert.equal(store.progressOf("kb-whisper-tiny"), null);
	});

	it("does not fetch a file that is already whole, and replaces a short one", async () => {
		const { disk, network, store } = makeStore();
		disk.place(KB_TINY);
		const config = `${FOLDER}/kb-whisper-tiny/config.json`;
		disk.files.set(config, 10);
		await store.download(KB_TINY);
		assert.deepEqual(
			[...new Set(network.asked.map((asked) => asked.url))],
			[downloadAddress(KB_TINY, KB_TINY.files[0])],
			"only the short file is fetched",
		);
		assert.equal(disk.files.get(config), KB_TINY.files[0].bytes);
	});

	it("a failed download names the other routes, leaves no half file, and the model stays absent", async () => {
		const { disk, network, store } = makeStore();
		network.failOnRequest = 3; // after two whole files
		await assert.rejects(store.download(KB_TINY), (error: unknown) => {
			assert.ok(error instanceof ModelDownloadError);
			assert.match(error.message, /connection reset/);
			assert.match(error.message, /huggingface\.co/);
			assert.match(error.message, /on another device and let Sync carry it/);
			assert.match(error.message, /by hand in vault-recorder\/models\/kb-whisper-tiny/);
			return true;
		});
		assert.equal((await store.status(KB_TINY)).present, false);
		assert.equal(store.isPresent("kb-whisper-tiny"), false);
		assert.deepEqual([...disk.files.keys()].filter((path) => path.endsWith(".part")), []);
		assert.equal(disk.files.get(`${FOLDER}/kb-whisper-tiny/config.json`), 3562);
	});

	it("a failed download names every file of the by-hand route, with the folder they go in", async () => {
		const { network, store } = makeStore();
		network.failOnRequest = 1;
		await assert.rejects(store.download(KB_TINY), (error: unknown) => {
			assert.ok(error instanceof ModelDownloadError);
			// The route is read back from the message the user is shown, not from a page that may not list it.
			for (const file of KB_TINY.files) {
				assert.ok(error.message.includes(file.path), `the message names ${file.path}`);
			}
			assert.ok(error.message.includes(`${FOLDER}/kb-whisper-tiny`), "the message names the folder");
			assert.doesNotMatch(error.message, /settings page lists them/);
			return true;
		});
	});

	it("a failed download says whether the network or the local disk failed", async () => {
		const network = makeStore();
		network.network.failOnRequest = 1;
		await assert.rejects(network.store.download(KB_TINY), /Could not download .* from huggingface\.co: connection reset/);

		const local = makeStore();
		local.disk.writesFail = "disk full";
		await assert.rejects(local.store.download(KB_TINY), (error: unknown) => {
			assert.ok(error instanceof ModelDownloadError);
			assert.match(error.message, /Could not save .* in vault-recorder\/models\/kb-whisper-tiny: disk full/);
			assert.doesNotMatch(error.message, /from huggingface\.co/);
			return true;
		});
	});

	it("a download cut off in the middle of a file leaves nothing at that file's path or beside it", async () => {
		const { disk, network, store } = makeStore();
		network.failOnRequest = 8; // the decoder's second range: forty megabytes of it already written
		await assert.rejects(store.download(KB_TINY), ModelDownloadError);
		const decoder = `${FOLDER}/kb-whisper-tiny/onnx/decoder_model_merged_quantized.onnx`;
		assert.equal(disk.files.get(decoder), undefined, "no half file under the real name");
		assert.deepEqual(
			[...disk.files.keys()].filter((path) => path.startsWith(decoder)),
			[],
			"and no .part beside it",
		);
		assert.equal((await store.status(KB_TINY)).present, false);
	});

	it("carries on from the whole files after a failure when pressed again", async () => {
		const { network, store } = makeStore();
		network.failOnRequest = 3;
		await assert.rejects(store.download(KB_TINY));
		network.failOnRequest = null;
		network.asked.length = 0;
		await store.download(KB_TINY);
		assert.equal((await store.status(KB_TINY)).present, true);
		assert.deepEqual(
			[...new Set(network.asked.map((asked) => asked.url))].slice(0, 1),
			[downloadAddress(KB_TINY, KB_TINY.files[2])],
			"starts at the third file, not the first",
		);
	});

	it("refuses a range that comes back shorter than asked rather than calling the model present", async () => {
		const { disk, network, store } = makeStore();
		network.shortBy = 1;
		await assert.rejects(store.download(KB_TINY), /got 3561 bytes/);
		assert.equal((await store.status(KB_TINY)).present, false);
		assert.equal(disk.files.get(`${FOLDER}/kb-whisper-tiny/config.json`), undefined);
	});

	it("runs once when pressed twice", async () => {
		const { network, store } = makeStore();
		const [first, second] = [store.download(KB_TINY), store.download(KB_TINY)];
		assert.equal(first, second);
		await first;
		assert.equal(network.asked.filter((asked) => asked.url.endsWith("/config.json")).length, 1);
	});
});

describe("remove", () => {
	it("trashes the model's subfolder through the trash port, and the model is absent after", async () => {
		const { disk, store } = makeStore();
		disk.place(KB_TINY);
		assert.equal((await store.status(KB_TINY)).present, true);
		await store.remove(KB_TINY);
		assert.deepEqual(disk.trashed, [`${FOLDER}/kb-whisper-tiny`]);
		assert.equal([...disk.files.keys()].length, 0);
		assert.equal((await store.status(KB_TINY)).present, false);
		assert.equal(store.isPresent("kb-whisper-tiny"), false);
	});

	it("keeps the other model: switching models keeps the old one until it is removed", async () => {
		const { disk, store } = makeStore();
		disk.place(KB_TINY);
		disk.place(KB_BASE);
		await store.remove(KB_BASE);
		assert.equal((await store.status(KB_TINY)).present, true);
		assert.equal((await store.status(KB_BASE)).present, false);
	});

	it("says so when the trash did nothing, instead of reporting a remove that did not happen", async () => {
		const { disk, store } = makeStore();
		disk.place(KB_TINY);
		disk.trashDoesNothing = true;
		await assert.rejects(store.remove(KB_TINY), /still in vault-recorder\/models\/kb-whisper-tiny/);
		assert.deepEqual(disk.trashed, [`${FOLDER}/kb-whisper-tiny`]);
	});
});
