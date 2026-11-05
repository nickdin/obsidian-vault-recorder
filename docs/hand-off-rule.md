# The hand-off rule

This document is the agreement between Vault Recorder, an Obsidian plugin that records audio, and a program of yours that turns that audio into text. It is written for someone building that program who has never seen the plugin. Follow it and the two work together through the vault's files alone: the plugin never calls your program and your program never calls the plugin. Obsidian Sync (or whatever carries the vault between devices) is the only wire.

The words of this rule are fixed English: property names, state words, section headings and the shape of a turn are copied character for character. This is rule version 1.

Every example note named below is a file in [`hand-off-fixtures/`](hand-off-fixtures/). The plugin's own tests parse and write every one of them byte for byte, and your program's tests should read the same files, so a drift shows on both sides.

## How the plugin asks

When a recording stops and its mode has a transcriber chosen, the plugin saves the audio file as `Recording YYYYMMDDHHMMSS.<ext>` and creates a **transcript note** with the same name and the extension `.md`: `Recording 20261019093539.m4a` gets `Recording 20261019093539.md`. The note goes in the transcript folder from the plugin's settings, which is the audio's own folder when the setting is empty. That note is the **request**. With no transcriber chosen, no note is created and nothing in this document applies.

The plugin creates a note whatever kind of transcriber the mode has: a hand-off program (yours), a service the plugin calls itself, or a model on one of the user's devices. The note says which in `transcribe-kind`, and **only a request whose `transcribe-kind` is `hand-off` is your program's** ([`22-not-for-a-program.md`](hand-off-fixtures/22-not-for-a-program.md) is one that is not). The others are the plugin's own, and wait for the device the user chose them for.

You do not find requests by folder or by name. **A request is recognised by its properties**: any note whose properties contain `rule-version` belongs to the plugin, and a note without it does not (see [`20-not-ours.md`](hand-off-fixtures/20-not-ours.md)). Read no other note.

The note is a Markdown note with a properties block (YAML front matter) first. After the properties come, in this order and only when they have something to say, a section under the heading `## Agent` and a section under the heading `## Transcript`. The transcript section runs from its heading to the end of the file. The agent section runs from its heading to the transcript heading.

## The properties

Each property has exactly one writer. Never write a property that is not yours, and leave every other line of the note exactly as you found it.

### Written by the plugin

These are written when recording stops, and again on cancel and on try again (cancel writes only `transcribe`).

| Property | Meaning |
| --- | --- |
| `rule-version` | `1`. The version of this rule. |
| `audio` | A link to the audio file, quoted: `"[[Recording 20261019093539.m4a]]"`. The text inside the brackets is the file's name, or, when another file in the vault has the same name, the shortest path that tells them apart; look the file up the way Obsidian resolves a link. |
| `audio-bytes` | The size of the audio file in bytes, when recording stopped. |
| `mode` | `daily-log`, `cursor` or `meeting`: which kind of recording this was. |
| `recorded` | When recording stopped, with its offset from UTC: `2026-10-19T09:35:39+02:00`. |
| `linked-from` | A link to the note the recording is linked from, quoted: `"[[2026-10-19 Planning]]"`. |
| `speaker-split` | `true` or `false`. Whether the transcript should be divided into turns by speaker. `true` for a meeting, `false` for the other modes. |
| `participants` | A list of the names the linking note gave for who took part, copied as written: `["[[Anna Svensson]]", "Bo Berg"]`. Present only when the linking note had such a list. |
| `owner` | The name of the person recording, copied as typed in the plugin's settings: `"[[Robin Example]]"`. Present only when the setting is filled in. |
| `language` | A language code such as `"sv"` or `"en"`, always written in double quotes so that a YAML reader takes a code like `no` as text and not as false. Present only when the plugin's language setting is not `detect`. |
| `attempt` | The number of this ask, starting at `1`. |
| `transcribe` | `requested`, or `cancelled` when the user cancelled it. |
| `transcribe-kind` | Which kind of transcriber the mode had when the request was written: `hand-off` (a program such as yours), `service` or `on-device` (the plugin's own), or `none` when the user tried again in a mode that no longer has a transcriber. Try again writes it afresh, so a request can change hands. A program takes a request only when it says `hand-off`. |

Written by the plugin later, and not yours to write: `naming` (`finished`), `keep-audio` (`true`), and `audio-deleted` (the date the audio file was deleted, `2026-11-02`). A program ignores `naming` and `keep-audio`.

**`audio-deleted` is the exception: a program reads it.** The plugin writes it the moment it decides the audio goes, before it moves the file to the trash, so a note that has the line may still have its audio for a moment. A request marked `audio-deleted` is never transcribed, whatever else the note says, including a request tried again after the deletion ([`14-audio-deleted.md`](hand-off-fixtures/14-audio-deleted.md)). The plugin deletes audio only when the transcript is finished, so a program meets this only on a request that was asked for again, or cancelled and then had its audio deleted by hand.

### Written by the transcriber (your program)

| Property | Meaning |
| --- | --- |
| `transcriber` | Your name, or the name of the device when a plugin acts as the transcriber: `vault-transcriber 2.0`. |
| `transcriber-state` | `taken`, `done`, `done-without-speaker-split` or `failed`. |
| `transcriber-at` | When the state last changed, in the same shape as `recorded`. |
| `transcriber-progress` | A whole number from 0 to 100, while `taken`. Write it at most every five minutes. |
| `transcriber-attempt` | The `attempt` this answer belongs to. **Always write it with the state.** |
| `transcriber-reason` | Why it failed, in quotes: `"the audio could not be decoded"`. On `failed`. |
| `transcriber-seconds` | How many seconds the transcription took. On `done` and `done-without-speaker-split`. |

### Written by the plugin when the transcript is done and an agent is chosen

| Property | Meaning |
| --- | --- |
| `agent` | `requested`, or `cancelled` when the user cancelled it. |
| `agent-kind` | Which kind of agent the mode had when the plugin asked: `hand-off` or `service`. Written again with every ask. A hand-off agent takes an ask only when it says `hand-off`. |
| `agent-attempt` | The number of this ask of the agent, starting at `1`. |
| `agent-for` | The `transcriber-at` of the transcript this ask is about. A later ask for a transcript with another `transcriber-at` is a new one; the same value is the same transcript, whatever the devices' clocks say. |
| `agent-requested-at` | When the plugin raised this ask, in the same shape as `recorded`. Written by "Run agent again", and again by each later one; also written by an automatic ask made after the overdue time had already passed since the transcript, so that ask reads waiting rather than overdue. An automatic ask made sooner has none, and a later automatic ask leaves an earlier run-again's stamp in place, neither changing nor removing it. A program ignores it: it is the plugin's own clock for how long it has waited. |

### Written by the agent

| Property | Meaning |
| --- | --- |
| `agent-by` | The agent's name, or the name of the device: `home-pc`. |
| `agent-state` | `working`, `done` or `failed`. |
| `agent-at` | When the agent's state last changed. |
| `agent-attempt-answered` | The `agent-attempt` this answer belongs to. Always written with the state. |
| `agent-reason` | Why it failed, in quotes. On `failed`. |

The order above is the order the properties appear in a note, and the plugin writes them in it. A program need not keep it, but a program that does produces the same bytes as the plugin does.

Dates and times are written as `YYYY-MM-DDTHH:MM:SS` followed by the offset from UTC as `+02:00`, or `Z`. The plugin cannot read a timestamp in any other shape, and treats one it cannot read as never overdue.

## Taking a request

There is one outside program per vault. This is not policed: two programs on one vault would transcribe everything twice, so do not run two.

A request is **waiting** when `transcribe` is `requested` and the note carries no answer for the current attempt, that is, no `transcriber-state` whose `transcriber-attempt` equals `attempt`. A fresh request is waiting. A request that failed on attempt 1 and was tried again is on attempt 2 and is waiting again, although the old `failed` answer is still in the note ([`10-try-again.md`](hand-off-fixtures/10-try-again.md)).

Take the waiting requests **oldest `recorded` first, one at a time**. Skip a request until all of these hold:

- its `rule-version` is one you know (see below);
- its `transcribe-kind` is `hand-off`. A request with another kind is the plugin's own, and one without the line was written before the line existed; skip both, since a program never takes a recording the user did not choose it for ([`22-not-for-a-program.md`](hand-off-fixtures/22-not-for-a-program.md)). A try again writes the line afresh, so a request can become yours later, or stop being yours;
- it has no `audio-deleted` property: a request whose audio is gone is never transcribed ([`14-audio-deleted.md`](hand-off-fixtures/14-audio-deleted.md));
- the audio file named by `audio` exists and its size has reached `audio-bytes`. Sync delivers a file in pieces, and a file it has not finished delivering must never be read. Check again later; do not report it failed.

To take a request, write `transcriber` (your name), `transcriber-state: taken`, `transcriber-at` (now) and `transcriber-attempt` (the note's `attempt`), changing nothing else ([`03-taken.md`](hand-off-fixtures/03-taken.md)). Then **wait two minutes and read the note again** before doing anything with the audio. If `transcriber` still holds your name, go on. If another name is there, another program took the request first: back off and leave the note alone. The wait is there because the vault is synced between devices and two writes can cross.

While you work, you may write `transcriber-progress`, at most every five minutes. Read the note again before each write and before you write the result. If `transcribe` has become `cancelled`, stop. If `attempt` has risen above the number you took, the user asked again: drop your work and take the request afresh. If the note is gone, drop the job.

## Writing the result

Replace everything from the `## Transcript` heading down with the transcript, or add that heading at the end of the note if it is not there. Leave an `## Agent` section above it alone. Then write `transcriber-state`, `transcriber-at` (now), `transcriber-attempt` and `transcriber-seconds`, and remove `transcriber-progress`.

**With `speaker-split: true`**, write each turn as one paragraph, starting with the time into the recording and the speaker in bold, and put a blank line between paragraphs:

```
[00:12:34] **Speaker 1:** Then we agree on the schedule and meet again on Friday.
```

The time is hours, minutes and seconds, two digits each. Write `transcriber-state: done` ([`04-done.md`](hand-off-fixtures/04-done.md)). If you could not divide the recording by speaker, write plain paragraphs with no times and no speakers and `transcriber-state: done-without-speaker-split` ([`05-done-without-speaker-split.md`](hand-off-fixtures/05-done-without-speaker-split.md)); the user can then ask again.

**With `speaker-split: false`**, write plain paragraphs, no times and no speakers, and `transcriber-state: done` ([`06-done-daily-log.md`](hand-off-fixtures/06-done-daily-log.md)).

**Names are written only as given.** Label speakers `Speaker 1`, `Speaker 2` and so on, or, when you know who is who, use a name from `owner` or `participants` exactly as it is written there, character for character, brackets and all. Write no other name. The user names speakers afterwards, in the plugin.

**Language.** When `language` is present, transcribe in that language. When it is absent, use your own default or detect it.

**Failing.** You may retry on your own before giving up. When you give up, write `transcriber-state: failed`, `transcriber-at`, `transcriber-attempt` and `transcriber-reason` with a sentence a person can read ([`07-failed.md`](hand-off-fixtures/07-failed.md)). Failing is an answer for the attempt: the request stays failed until the user tries again.

**A rule version you do not know.** If `rule-version` is not one you understand, touch nothing but your own lines: write your name in `transcriber`, `transcriber-state: failed`, `transcriber-at`, `transcriber-attempt` and `transcriber-reason: "unknown rule version 2"` (with the version you found) ([`13-unknown-rule-version.md`](hand-off-fixtures/13-unknown-rule-version.md)). Read nothing else in the note.

## Cancel, try again, and the attempt counter

The attempt counter is the guard that keeps old work from counting. An answer counts only for the attempt it names.

- **Cancel.** The user cancels and the plugin writes `transcribe: cancelled` ([`08-cancelled.md`](hand-off-fixtures/08-cancelled.md)). Honour it as soon as you see it: do not take the request, and stop work on it. If a transcript lands after a cancel, because you were already writing, it is kept and the request shows as done ([`09-cancelled-late-transcript.md`](hand-off-fixtures/09-cancelled-late-transcript.md)).
- **Try again.** The plugin raises `attempt` by one and writes `transcribe: requested`. Your earlier answer stays in the note, but it names the old attempt, so the request is waiting again ([`10-try-again.md`](hand-off-fixtures/10-try-again.md)). Take it as any other waiting request. Your new answer replaces the old `transcriber-*` lines and the transcript section.
- **Remove.** The user removes the recording with "Remove everything" and the plugin moves the transcript note, and the audio, to the trash. The plugin cancels a request still in the queue first, writing `transcribe: cancelled` for the transcriber and `agent: cancelled` for an agent still answering. The cancel and the move to the trash run back to back, so a program usually sees only the note vanish, not the cancel: **a note that vanishes is the drop signal**, and `transcribe: cancelled` and `agent: cancelled` are what a program sees when it happens to look in between, or when Obsidian's trash is the vault's own `.trash` folder and the note is still there to read. A program whose transcript note is gone drops the job: it writes nothing, does not recreate the note, and does not look for the audio. This holds at every step, while the request is waiting, taken, being worked on, or about to be written back, and for the agent's lines as well as the transcriber's.
- **A note that is not the plugin's.** No `rule-version` means not a request; do not read or write it.

## The states

A state is never written. The plugin derives it from the note, and your program may do the same. This is how, in the order the plugin tests them (`TranscriberState` in the plugin's `transcript-note.ts`):

| State | When |
| --- | --- |
| done | `transcriber-state` is `done` and `transcriber-attempt` equals `attempt`. |
| done without speaker split | `transcriber-state` is `done-without-speaker-split` for the current attempt. |
| cancelled | `transcribe` is `cancelled`, and no finished transcript for the current attempt. |
| failed | `transcriber-state` is `failed` for the current attempt. |
| being transcribed | `transcriber-state` is `taken` for the current attempt. |
| waiting | none of the above, including an answer to an earlier attempt, an answer without `transcriber-attempt`, and a state word the plugin does not know. |

A note with a `rule-version` the plugin does not understand has no state; the plugin shows it as such and does not read the rest.

**Overdue** is waiting, or being transcribed with no change, for longer than the overdue time in the plugin's settings (24 hours by default). It is measured on the plugin's own clock, against the timestamps in the note. A waiting request counts from the later of `recorded` and `transcriber-at`; a taken one counts from `transcriber-at`. So a program that takes a request should write `transcriber-at` whenever it changes state, and a long job should not be left `taken` without a change for longer than the overdue time. A note whose timestamp cannot be read is never overdue.

## The agent lines

An agent reads a finished transcript and writes an answer into the note: a summary, a list of actions, a name for each speaker. The agent follows the same shape as the transcriber.

- When the transcript is done and the mode has an agent chosen, the plugin writes `agent: requested`, `agent-kind` and `agent-attempt` ([`15-agent-requested.md`](hand-off-fixtures/15-agent-requested.md)). **A hand-off agent takes only an ask whose `agent-kind` is `hand-off`**; one with another kind, or with no `agent-kind` line, is skipped. A try again for the agent raises `agent-attempt` by one. A try again by hand also writes `agent-requested-at`, and so does an automatic ask made after the overdue time had already passed since the transcript, so the new ask is counted from when it was raised and not from the older lines still in the note.
- A hand-off agent takes it by writing `agent-by` (its name), `agent-state: working`, `agent-at` and `agent-attempt-answered` (the note's `agent-attempt`) ([`16-agent-working.md`](hand-off-fixtures/16-agent-working.md)).
- When it has an answer it writes the answer under a heading `## Agent`, placed above the `## Transcript` heading, and `agent-state: done`, `agent-at` and `agent-attempt-answered` ([`17-agent-done.md`](hand-off-fixtures/17-agent-done.md)). When it cannot, it writes `agent-state: failed`, `agent-at`, `agent-attempt-answered` and `agent-reason` ([`18-agent-failed.md`](hand-off-fixtures/18-agent-failed.md)).
- A hand-off agent replaces speaker labels in the text itself when it knows who is who, with a name from `owner` or `participants` exactly as written there.
- `agent: cancelled` is honoured as soon as it is seen, and an agent answer that lands after a cancel is kept, as for the transcriber.

The agent's states are derived the same way. The agent is done when `agent-state` is `done` and `agent-attempt-answered` equals `agent-attempt`; cancelled when `agent` is `cancelled` and it is not done; failed or working when `agent-state` says so for the current attempt; waiting otherwise. Working is overdue when `agent-at` is older than the overdue time ([`19-agent-overdue.md`](hand-off-fixtures/19-agent-overdue.md)); waiting counts from the latest of `recorded`, `transcriber-at`, `agent-at` and `agent-requested-at`, so a run-again on an overdue agent reads waiting until the overdue time has passed again.

## The serving device

The plugin itself can act as a transcriber or agent, on a device you choose, for notes it takes. A plugin acting that way is a program under this rule: it writes the same lines, names the device in `transcriber` or `agent-by`, and follows the same two-minute rule. It never takes hand-off requests, which are for your program alone. It tells them apart by `transcribe-kind` and `agent-kind`; on a note without the line it goes by the mode's kind in its settings.

## The fixtures

Each file is a complete note. The tests give each one a clock of `2026-10-19T12:00:00+02:00` and an overdue time of 24 hours, and expect the state below. A transition is a fixture produced from an earlier fixture by one write, and the plugin's tests make each by that write and compare the bytes.

| Fixture | State | Made from |
| --- | --- | --- |
| [`01-requested-daily-log.md`](hand-off-fixtures/01-requested-daily-log.md) | waiting, a daily-log request with only the properties that always apply | the plugin, at stop |
| [`02-requested-meeting.md`](hand-off-fixtures/02-requested-meeting.md) | waiting, a meeting with `participants`, `owner` and `language` | the plugin, at stop |
| [`03-taken.md`](hand-off-fixtures/03-taken.md) | being transcribed, 42 percent | 02, taken, with progress |
| [`04-done.md`](hand-off-fixtures/04-done.md) | done, with a speaker split | 03, done |
| [`05-done-without-speaker-split.md`](hand-off-fixtures/05-done-without-speaker-split.md) | done without speaker split | 03, done without split |
| [`06-done-daily-log.md`](hand-off-fixtures/06-done-daily-log.md) | done, plain paragraphs | 01, taken, done |
| [`07-failed.md`](hand-off-fixtures/07-failed.md) | failed | 02, taken, failed |
| [`08-cancelled.md`](hand-off-fixtures/08-cancelled.md) | cancelled | 01, cancelled |
| [`09-cancelled-late-transcript.md`](hand-off-fixtures/09-cancelled-late-transcript.md) | done, a transcript landed after the cancel | 01, taken, cancelled, done |
| [`10-try-again.md`](hand-off-fixtures/10-try-again.md) | waiting, attempt 2 over an old failed answer | 07, try again |
| [`11-overdue-waiting.md`](hand-off-fixtures/11-overdue-waiting.md) | waiting and overdue | the plugin, at stop, two days ago |
| [`12-overdue-taken.md`](hand-off-fixtures/12-overdue-taken.md) | being transcribed and overdue | 11, taken, a day ago |
| [`13-unknown-rule-version.md`](hand-off-fixtures/13-unknown-rule-version.md) | a rule version the plugin does not know; a program reported it failed | a future plugin, then a program |
| [`14-audio-deleted.md`](hand-off-fixtures/14-audio-deleted.md) | waiting and overdue; `audio-deleted` is set, so a program never takes it | done, audio deleted, tried again |
| [`15-agent-requested.md`](hand-off-fixtures/15-agent-requested.md) | done; the agent is waiting | 04, agent requested |
| [`16-agent-working.md`](hand-off-fixtures/16-agent-working.md) | done; the agent is working | 15, agent working |
| [`17-agent-done.md`](hand-off-fixtures/17-agent-done.md) | done; the agent is done, with an `## Agent` section | 16, agent done |
| [`18-agent-failed.md`](hand-off-fixtures/18-agent-failed.md) | done; the agent failed | 16, agent failed |
| [`19-agent-overdue.md`](hand-off-fixtures/19-agent-overdue.md) | done; the agent is working and overdue | an older meeting, agent working a day ago |
| [`20-not-ours.md`](hand-off-fixtures/20-not-ours.md) | not the plugin's: no `rule-version` | someone else |
| [`21-agent-run-again.md`](hand-off-fixtures/21-agent-run-again.md) | done; the agent was overdue and the user ran it again, so it is waiting and not overdue | 19, run again, a day and four hours later |
| [`22-not-for-a-program.md`](hand-off-fixtures/22-not-for-a-program.md) | waiting, but `transcribe-kind` is `service`, so a program never takes it | the plugin, at stop, in a mode with a service transcriber |

## What a program must not do

- Read or write a note without `rule-version`.
- Write a property it does not own, or change the lines of the ones it does not write. Change only your own lines and the `## Transcript` section.
- Move, rename or delete the audio file or the note, or rewrite the link to the recording in any other note.
- Transcribe a request with `audio-deleted`, a request on a rule version it does not know, or one whose audio has not reached `audio-bytes`.
- Take a request whose `transcribe-kind` is not `hand-off`, or an agent ask whose `agent-kind` is not `hand-off`, including one without the line.
- Write a speaker name that is not `Speaker N`, `owner` or an entry of `participants`.
- Leave a request `taken` without a way forward: finish it or fail it.
