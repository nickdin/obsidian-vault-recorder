# Vault Recorder

An Obsidian plugin that records audio straight into your vault: a quick spoken thought into today's daily log, a note at the cursor, or a meeting or lecture with both sides of the audio (Meet, Zoom, Discord, anything that plays through your computer). Each recording can then be turned into text and handed to an agent that summarises or tidies it — or left as audio, which is all a fresh install does.

Everything runs inside Obsidian. There is no separate program to install and no native binary: the on-device speech engine is bundled into `main.js` in compressed form, which is why `main.js` is about 9.5 MB.

Numbers such as #82 in the code and its comments refer to the author's private design record, which is not published, and so do the files they cite that are not in this repository.

## The three modes

One recording at a time. Each mode is a toggle: click to start, click again to stop. Each has a ribbon icon and a command.

- **Record a thought into the daily log** (microphone icon). Records the microphone and puts `![[Recording …]]` last under the notes heading of today's daily log, above the next heading of any level, creating the section if it is missing. The notes heading is a setting, text plus level, `# Notes` by default. It is found by its level and its text, regardless of capitals and runs of spaces: `# notes` and `#  Notes` match `# Notes`, while another level or more words is a different heading. Refuses to start if today's daily log does not exist.
- **Record at the cursor in the active note** (file-audio icon). Records the microphone and inserts the link where the cursor was **when recording started**, so switching notes mid-recording does not move the link. If that position is gone at stop, the link is appended to the note instead.
- **Record a meeting with system audio** (monitor-play icon; desktop only). Captures the microphone and the computer's own audio — the other side of a call — mixes them into one track, and inserts the link last under the notes heading when the meeting note has one, otherwise at the cursor. If system audio cannot be captured at all, nothing is written and a notice suggests the cursor mode instead: the plugin refuses rather than save a half recording that only holds your own voice.

While recording, a level meter appears as a fourth ribbon icon and moves with the audio. If it stops moving during a meeting, the system-audio side has gone quiet.

## What the recordings are

Files are named `Recording YYYYMMDDHHMMSS.<ext>` and land in the audio file folder from the settings (Obsidian's attachment folder when that setting is empty). The filename pattern is fixed, so other tools can rely on it. The format is chosen once when the plugin loads: `.m4a` where the platform supports it, otherwise `.webm`. `.m4a` names the container, not the codec — on desktop Obsidian the codec inside is usually Opus, on iOS AAC. The settings' *Troubleshooting* section shows the current choice.

Recordings are made at 32 kbit/s, mono, about 14 MB an hour. A phone is asked for the same and may ignore it, so a phone's files can be larger.

## Transcribers and agents

Each recording mode — daily log, cursor, meeting — has its own **transcriber**, which turns the recording into text, and its own **agent**, which acts on that text. Each can be *None*, and a fresh install has *None* everywhere: it records audio and nothing else until you choose. The text goes into a **transcript note** next to the recording (or in the transcript folder, when one is set).

**The three transcriber kinds, and what each sends where:**

- **On this device.** A speech model runs inside Obsidian; nothing is sent. Daily-log and cursor modes only, and not on a phone.
- **Service.** An address, a key and a model name. The recording is sent from the device that does the work to `<address>/audio/transcriptions` — the request shape OpenAI made common: a multipart upload of the file and the model name, the language when you set one, and the key as a bearer token when you set one — and plain text comes back. Used for a meeting, it returns text without speakers.
- **Hand-off.** Nothing is sent. The plugin writes a note asking for a transcript; a program of yours reads it and writes the answer into the same note, following [the hand-off rule](docs/hand-off-rule.md). It serves every mode.

**The two agent kinds:**

- **Service.** Sends the transcript note, the note that links the recording and your optional context note, together with your instruction and the model name, to `<address>/chat/completions` (the OpenAI-style chat request), with the key as a bearer token when you set one. Nothing else is sent.
- **Hand-off.** Works like the hand-off transcriber, through the transcript note. It has no instruction box, because your program carries its own.

There is no on-device agent.

**How the agent behaves:**

- **It runs once per transcript, by itself,** when the transcript is done and before you name speakers by hand.
- **The instruction** is one box per mode, in your own words and language. Left empty, a meeting gets a summary with decisions and actions, each with an owner; the daily log and the cursor mode get a tidy-up instead — your own words in the first person, tasks as `- [ ]` lines, nothing added that was not said.
- **The language of the answer** is named in the request: the language setting when it has one, otherwise Swedish when the transcript is plainly Swedish, otherwise the transcript's own language is asked for in general words. A small local model, left to itself, has been seen answering a Swedish recording in English.
- **A transcript that finished before you chose an agent for that mode is never sent automatically,** however old, so choosing an agent never sends one paid request per old recording. The command *Run this recording's agent again* asks for an older one by hand.
- **Run agent again** counts its waiting time from when you asked, so it does not read overdue at once. **Cancel agent** stops one that is waiting, for example for a key that is on another device.
- **Naming speakers.** Speakers are labelled `Speaker 1`, `Speaker 2` and so on; click a label to name it, from your own name and the meeting note's participant list. An agent that is sure may name them from the same list; the plugin ignores any name not on it, and a wrong name costs you one rename.
- **Choosing a model for a service agent:** it must be a chat model that follows an instruction, writes in the transcript's language and has a context window big enough for the whole transcript. An hour's meeting is about 15,000 tokens. A model server you run yourself does not take its context window from the plugin: raise it there.
- **One model that has done the daily-log job well** is Anthropic's Claude Haiku 5.5: address `https://api.anthropic.com/v1`, model `claude-haiku-5-5`, and a key from platform.claude.com. On seven Swedish and English daily-log recordings it answered each in the transcript's language, in about two seconds, with nothing added, for under one cent in all. Your recording's text then leaves your device for Anthropic, and Anthropic describes this OpenAI-compatible address as meant for testing and comparing models rather than for production. Two small models run locally did not do the job in Swedish: `llama3.2` added, repeated or garbled words, and `qwen3.5:4b` thought for over ten minutes on one sentence.
- **A service that says no** shows as *failed* with the service's own message. A send that fails for lack of network, or to an address this device cannot reach, is not a failure: the recording waits with the reason and is retried.

**Transcribe by hand.** The command *Transcribe this recording*, used on an older recording, builds the request the recording would have had at stop, using the mode of the note that links it. The other commands — *Cancel this recording's transcription*, *Try this recording's transcription again*, *Cancel this recording's agent* — act on the recording in focus, and *Open the transcription queue* (also a ribbon icon) opens a side panel that lists the transcript notes by state — waiting, being transcribed, overdue, failed, finished recently and so on.

## Outside addresses the plugin contacts

The plugin contacts nothing on its own. It reaches the network only in these cases:

- **Hugging Face (`huggingface.co`)**, only when you press a speech model's download button in the settings. It fetches that model's files, pinned to one exact version, into the model folder (default `vault-recorder/models`, one subfolder per model). None of your recordings or notes are sent. Files you place there by hand count the same. The list holds four models: KB-Whisper tiny and base for Swedish, Whisper tiny and base for other languages; base is recommended in each.
- **A service address you typed yourself**, for a service transcriber (the recording audio, the model name and the language) or a service agent (the transcript note, the linking note, your context note, your instruction and the model name). The key, if you set one, is sent only as the `Authorization` header to the address it belongs to.

The settings' *Troubleshooting* section lists, for every mode, exactly what is sent where with your current choices.

**Keys stay on each device.** A key is kept in Obsidian's Keychain and typed once on each device that needs it; the settings file holds only its name, so Obsidian Sync never carries a secret. This needs Obsidian 1.11.4 or newer.

**Undocumented API.** While *Use the Daily notes settings* is on, the plugin reads the daily-log folder and filename pattern from the core Daily Notes plugin's configuration through an internal Obsidian API that is not documented. If that ever breaks, switch the setting off and fill in the two fields by hand.

## Devices and who does the work

- **The recording device goes first.** It transcribes or sends for itself when it can, and runs the agent itself once the transcript is done.
- **One serving device per vault, off by default.** Under *This device* in the settings you can make one device the vault's *Serving device*, typically a computer that stays on: after three minutes it takes any recording still waiting for a service or on-device transcriber or agent, using its own key or speech model. The plugin does not check that you chose only one; two can race for the same recording. A serving device never takes a hand-off request.
- **One outside program per vault.** The program a hand-off transcriber or agent talks to follows [the hand-off rule](docs/hand-off-rule.md): what the plugin writes, what the program writes back, and how two programs avoid taking the same note. Run one such program per vault.
- **Waiting always says why.** A recording a device cannot handle waits with one reason line and the ways out: enter the key on this device, download the model here, pick another transcriber for the mode, or let a serving device take it.

## Sizes and limits

At 32 kbit/s a minute is about 240 kB. The plugin never splits a recording: one over a service's limit is refused and shows as failed, and you pick a service with a higher limit, or hand-off. The services' published limits, read on 2026-10-02, as minutes of recording:

| Service | Limit | Minutes at 32 kbit/s |
|---|---|---|
| OpenAI | 25 MB | 104 |
| Groq, free tier | 25 MB | 104 |
| Groq, paid | 100 MB | 416 |
| Together AI | 80 MB per upload | 333 |
| Mistral (Voxtral; no Swedish) | 1 GB and 3 hours | 180 |
| A server you run (Speaches, LocalAI, whisper.cpp) | none documented | not measured |

Services that use their own request format instead of OpenAI's — Deepgram, AssemblyAI, ElevenLabs, Speechmatics, Gladia, Azure — cannot be used.

**Obsidian Sync Standard carries no file over 5 MB** — about 21 minutes of recording. A hand-off recording that Sync does not carry never reaches your program and goes overdue in the queue. On Sync Standard, hand-off therefore works for recordings under about 20 minutes; longer ones need an on-device transcriber, or a service on the recording device. Sync Plus carries 200 MB.

## On a phone

iPhone and Android follow the same rules; they were measured on an iPhone, and **Android has not been tested.** A phone records in daily-log and cursor mode only; the meeting mode is desktop only. A mode's transcriber and agent apply as chosen.

- On-device transcription does not run on a phone; the recording waits for a serving device or another transcriber.
- A service address iOS refuses (plain `http://`) makes the recording wait with the reason, and a serving device takes it.
- **Keep Obsidian on screen while a phone sends:** iOS stops the work seconds after Obsidian leaves the screen. When you return, the phone lets go of its request and tries again.
- **Audio sync must be on for the phone** for its recordings to reach a hand-off transcriber at all: Obsidian Sync carries a file type only where that device's sync settings include it.

## Removing a recording

Four entries take a recording out of a note: **Remove link**, **Remove link and audio**, **Remove everything** and **Delete audio**.

- **Where they are.** Right-click an audio embed in the editor (Live Preview or source mode): the entries are at the end of Obsidian's own menu. Reading view has no editor menu; there, use the buttons under each row of the transcription queue, or the line of buttons at the top of the transcript note.
- **Remove link** asks nothing. When the note is open it goes through the editor, so Ctrl+Z brings the link back; otherwise the note is rewritten and the notice says it cannot be undone. It finds the link however it is written, leaves fenced code blocks alone, and in a meeting note also removes the transcript link beside it. No file is touched.
- **The three entries that delete files** ask once, naming the files and any other notes that link to them. A recording that this device is transcribing right now is refused until the run ends. A recording still in the queue, and an agent still answering, are cancelled first; then the files go through Obsidian's trash setting. *Remove link and audio* keeps the transcript note and records the day the audio went; *Remove everything* trashes the transcript note as well; *Delete audio* leaves the link where it is.
- **Greyed entries** say why in their tooltip (in the editor menu, in brackets): the audio is already deleted, no note links to the recording, or more than one does.

## Guards

- **Silence guard:** a recording whose level never rose above near-silence, or that is under 8 KB, is not saved, and a notice says so. This catches a dead microphone before a transcriber picks it up.
- **One recorder at a time:** a double-click cannot start two recorders, and no two modes run at once.
- **Closing Obsidian loses the recording in progress.** If Obsidian is closed or crashes mid-recording, that recording is lost. This is deliberate.
- **Keep the screen awake while recording** (on by default). It works on iOS. On at least one Linux desktop (KDE on Wayland) the request is accepted and silently has no effect, so the screen can still go dark mid-recording.

## Platform notes

- **Linux on Wayland:** every meeting recording starts with the system's screen-share dialog, which is how Wayland grants access to the computer's audio. Closing the share, or changing the default output device, stops the recording cleanly: the file up to that point is saved and a notice appears.
- **Windows:** the meeting mode starts without a dialog. A known open problem there: changing the audio output device mid-meeting can silently leave the rest of the recording with the microphone only.
- **A device change mid-recording** (microphone modes): the recording continues and follows the new input device.

## Settings

Per mode: a transcriber and an agent, with their fields (speech model; or address, key name and model; and for an agent, the instruction and a context note). Also the notes heading (text and level), *Your name*, the participant list property, the language spoken in recordings, the daily-log folder and filename pattern (or *Use the Daily notes settings*), the audio, transcript and model folders, the keep time and the overdue time, *This device* (its name and whether it is the serving device), *Keep the screen awake while recording*, and a read-only *Troubleshooting* section.

## Install

**From Obsidian's community plugins**, once the plugin is listed there: Settings → Community plugins → Browse, search for *Vault Recorder*, install and enable it.

**By hand:** download `main.js`, `manifest.json` and `styles.css` from a release and copy them into `<your vault>/<config folder>/plugins/vault-recorder/` (the config folder is `.obsidian` unless you changed it), then enable the plugin under Settings → Community plugins.

## Development

Needs Node.js and npm.

```bash
npm ci           # install dependencies
npm run build    # type check, then bundle into main.js
npm test         # run the tests
npm run lint     # Obsidian's lint rules
```

`npm test` runs the tests without type-checking them; `npm run build` is the type check.

`src/` holds the plugin's modules, each beside its tests; each module's header says what it does. The hand-off rule and its example notes are in `docs/`.

## Licence

MIT. See [LICENSE](LICENSE).
