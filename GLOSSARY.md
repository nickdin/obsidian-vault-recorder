# Vault Recorder

An Obsidian plugin that records audio into the vault and gets each recording turned into text by a transcriber the user chooses, optionally handing that text to an agent the user chooses. Nothing about transcription or agents is fixed to one provider or one person's setup.

## Recording

**Recording**:
An audio file the plugin captures and saves into the vault, together with the link it places in a note.
_Avoid_: memo, voice note, clip

**Daily-log mode**:
The way of recording that captures the microphone and links the recording into the day's daily log.
_Avoid_: quick capture, thought mode

**Cursor mode**:
The way of recording that captures the microphone and links the recording where the cursor was in the active note — speaking instead of typing.
_Avoid_: inline mode, dictation

**Meeting mode**:
The way of recording that captures both the microphone and the computer's own audio, so both sides of a call are heard.
_Avoid_: system-audio mode

**Meeting**:
A recording made in meeting mode, whether the meeting itself was in a room, hybrid or online.
_Avoid_: call recording, system-audio recording

**Meeting note**:
The note a meeting is linked from. Vault Recorder never makes it; the user or another plugin does.
_Avoid_: meeting (for the note or for the calendar event)

**Owner**:
The person the plugin records for. Left out of a meeting note's participant list, yet one of every meeting's speakers.
_Avoid_: me, the user (for the person speaking)

**Participant list**:
The people a meeting note names as taking part, leaving the owner out; `deltagare` in the vault the plugin was first built for.
_Avoid_: deltagare (as a general term), attendees

**Daily log**:
The note for one calendar day that quick recordings are linked into.
_Avoid_: daily note, journal

**Daily Notes switch**:
The setting "use the Daily notes settings", on by default: today's daily log is looked up where Obsidian's Daily Notes plugin puts it. Off, the plugin's own daily-log folder and filename pattern are used instead, and shown in the settings. A vault upgraded from the first version keeps what it had: the old default folder and pattern become the switch turned on, a pair the user chose becomes the switch turned off.
_Avoid_: daily-log override

**Notes heading**:
The heading in a daily log or a meeting note under which recordings are linked, set as a text and a level; `Anteckningar` at level 1 in the vault the plugin was first built for (the default of an upgraded install; a fresh install starts at `Notes`, level 1). The heading is found by its level and its text regardless of capitals and runs of spaces; another level or more words is a different heading.
_Avoid_: Anteckningar (as a general term), notes section

**Audio folder**:
The folder inside the vault where recordings are saved and stay; a recording is never moved. Obsidian's own attachment folder unless the user chooses another.
_Avoid_: recordings folder, attachment folder (for this setting)

**Keep time**:
The number of days a recording's audio is kept after its transcript is finished, after which the plugin deletes the audio and the transcript remains. Unset by default, and then nothing is deleted. A transcript is finished when everything asked for has arrived: a speaker split that failed, or an unnamed speaker the user has not chosen to leave unnamed, means it is not.
_Avoid_: retention, expiry, cleanup

**Audio held**:
The queue group for a recording whose audio a hold keeps past its keep time — the user's choice to keep it, a speaker split that failed, an unnamed speaker — with the reason the hold gives. The plugin deletes nothing in it until the hold ends.
_Avoid_: pinned audio, kept audio (that is the user's own choice to keep)

**Overdue time**:
The number of hours a recording may wait for its transcript before it counts as overdue. 24 by default.
_Avoid_: timeout, deadline

## Turning speech into text

**Transcript**:
The text of one recording.
_Avoid_: transcription (for the text itself)

**Transcript note**:
The note that holds one recording's transcript and, until the transcript arrives, says how far it has come. Every transcript lives in one, whichever transcriber made it; the note that links the recording shows or links the transcript note, and never holds the text itself.
_Avoid_: transcription file, transcript file

**Transcript folder**:
The folder inside the vault where transcript notes are kept; the audio folder unless the user chooses another.
_Avoid_: output folder, transcription folder

**Queue**:
The recordings whose transcript has not arrived yet — waiting or being transcribed — oldest first.
_Avoid_: backlog, jobs, pending list

**Transcriber**:
Whatever the user has chosen to turn a recording into a transcript. It comes in three kinds: on-device, service and hand-off. Chosen per recording mode, so each mode may have a different one, or none — with none, the plugin records and no transcript is made.
_Avoid_: engine, backend, provider, whisper

**On-device transcriber**:
A transcriber that runs inside Obsidian on the same computer that made the recording, so nothing leaves it.
_Avoid_: local transcriber (ambiguous with a self-hosted server)

**Model**:
The file set an on-device transcriber or an on-device agent runs: a speech model turns audio into text, an agent model reads a transcript. Chosen from the model list and kept in the model folder.
_Avoid_: weights, checkpoint, whisper (for the model)

**Model list**:
The models the plugin knows how to run, each at one exact published version with the size of every file. The plugin offers nothing outside it, and a new plugin release is what changes it.
_Avoid_: catalogue, registry

**Model folder**:
The folder inside the vault where models are kept, one subfolder per model, so one copy serves every device the vault syncs to.
_Avoid_: cache, model path

**Service transcriber**:
A transcriber reached at an address with a key — an online service or a server the user runs themselves.
_Avoid_: API transcriber, cloud transcriber

**Key**:
The password a service transcriber or a service agent is called with. Kept by Obsidian on the device where it was entered, never in the vault, so every device that needs one has it entered there; a server the user runs at home may need none.
_Avoid_: API key, token, secret (outside Obsidian's own wording)

**Hand-off transcriber**:
A transcriber outside Obsidian that the plugin asks through the vault itself: the plugin leaves a documented request in the vault, and an outside program picks it up and writes the transcript back. Every kind of transcriber gets a request; the program takes only those whose `transcribe-kind` says `hand-off`, the kind the mode had when the request was written.
_Avoid_: watcher, daemon, sidecar

**Speaker split**:
A transcript divided into turns, each attributed to one speaker. Asked for per recording: on by default for a meeting, off by default for any other recording.
_Avoid_: diarization (outside code), speaker labels

**Unnamed speaker**:
A speaker in a transcript still known only by its number, `Speaker N`. Naming one puts a person in place of the number throughout the transcript; the user may also choose to leave the rest unnamed.
_Avoid_: unknown speaker, anonymous speaker

**Naming list**:
The short list that opens on a click on a speaker's label in a transcript: the owner first, then the participants not yet used, then the names already in the note, then a box for any name. The choice is written in place of the label throughout the note — a participant or the owner exactly as listed, link and all, a typed name as plain text — and two labels given one name become one speaker. "Leave the rest unnamed" closes the question with `naming: finished`; trying again removes it.
_Avoid_: speaker menu, name picker

**Request**:
What the plugin writes into a transcript note, as properties, to ask for a transcript: the audio and its size, the mode, when recording stopped, the note that links it, whether to split speakers, who took part, the owner's name and the language when known. Written when a recording stops, and by the command "Transcribe this recording" for an older recording that has none, built with the mode of the note that links the recording: a daily log gets the daily-log request; a note that names participants gets the meeting transcriber, speaker split and participants; any other note gets the mode its other recordings agree on; a recording in no note, in notes of different modes, or in a note with nothing to go by gets the daily-log request and the notice says why. Cancel and try again, called by commands and by buttons on the state line, change it afterwards: cancel marks it cancelled, try again raises the attempt.
_Avoid_: job, ticket, task

**Attempt**:
The number in a transcript note saying which ask for a transcript this is. It starts at 1 and rises by one on each try again; an answer counts only for the attempt it names, so an answer to an earlier attempt leaves the recording waiting again.
_Avoid_: retry count, version

**Hand-off rule**:
The published agreement between the plugin and a hand-off transcriber: what the plugin writes into a transcript note to ask for a transcript, and what the outside program writes back. Anyone may write a program that follows it.
_Avoid_: protocol, contract, vault protocol

**Serving device**:
The one device in a vault, chosen by the user, whose plugin takes recordings other devices cannot handle themselves — a service or on-device transcriber or agent they lack the key or model for — and does the work with its own. It claims each one in the transcript note so no device does it twice.
_Avoid_: worker, relay, server (ambiguous with a server the user runs)

## After the transcript

**Agent**:
Whatever the user has chosen to read a finished transcript and write an answer into its transcript note — a summary, a list of actions, names for the speakers. It comes in the same three kinds as a transcriber and is chosen per recording mode, so each mode may have a different one, or none. Optional; the plugin is complete without one. It never writes into the note that links the recording.
_Avoid_: step 2, bearbeta, post-processor, AI

**Instruction**:
The text that tells an agent what to do with a transcript, written by the user per recording mode in their own words and language. A hand-off agent carries its own instruction in the outside program instead.
_Avoid_: prompt (outside code), system prompt

**Default instruction**:
What an empty instruction box stands for, set per recording mode: for a meeting, a summary with decisions and actions, each with an owner; for the daily log and the cursor mode, a tidy-up of what was said in the speaker's own words, tasks as `- [ ]` lines, nothing added.
_Avoid_: default prompt

**Chosen moment**:
The time a mode's agent was last switched on, saved with that mode's settings so every device judges the same way. A service agent or hand-off agent is asked automatically only for transcripts that finished at or after it, however old; a transcript that finished before is never sent unless the user asks by hand with "Run agent again". When the moment is unknown the agent is asked only for transcripts under the overdue time old.
_Avoid_: enabled-at

**Run agent again** / **Cancel agent**:
The two by-hand actions on an agent. Run again asks for the agent's step afresh, asking first before it replaces a section the user may have edited, and counts the new waiting time from the moment of asking. Cancel stops an agent that is waiting or working, so naming speakers by hand is allowed; the agent is not asked again until Run again.
_Avoid_: retry agent, abort

**Service agent**:
An agent reached at an address, usually a model the user runs themselves or an online service. The plugin sends it the transcript, the note that links the recording and an optional context note, writes its answer under `## Agent`, and applies any `Speaker N = name` lines it ends with. It is asked once per transcript, automatically; the user can ask again by hand.
_Avoid_: AI step, summariser

**Hand-off agent**:
An agent outside Obsidian that the plugin asks through the vault itself, the way a hand-off transcriber is asked: the request and the answer are lines in the transcript note. It takes only an ask whose `agent-kind` says `hand-off`.
_Avoid_: watcher, daemon, sidecar
