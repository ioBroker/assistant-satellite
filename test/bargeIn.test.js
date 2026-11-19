// Barge-in of the LocalListener (ioBroker transport) against fake audio, a fake wake-word model and a fake host.
// Runs against the build: npm run build && node --test test/
const Module = require('node:module');
const path = require('node:path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const FRAME_SAMPLES = 1280;

/** Everything the fakes saw */
const world = { plays: [], mic: null, resets: 0, processed: 0 };

class FakeMic {
    start(onData) {
        world.mic = { push: buf => onData(buf) };
    }
    async stop() {}
}

/** Playback that runs until `finish()` (a reply) or ends at once (the beep) */
function fakePlayPcm(pcm) {
    const beep = pcm.toString() === 'PLING';
    let finish;
    const done = new Promise(resolve => (finish = resolve));
    const play = { beep, killed: false, finished: false, finish: () => ((play.finished = true), finish()) };
    play.proc = {
        kill: () => {
            play.killed = true;
            finish();
        },
    };
    world.plays.push(play);
    if (beep) {
        play.finish();
    }
    return { proc: play.proc, done };
}

class FakeWakeWord {
    async load() {}
    reset() {
        world.resets++;
    }
    /** The score travels in the last sample of the frame (score × 1000) */
    async process(frame) {
        world.processed++;
        await new Promise(resolve => setImmediate(resolve));
        return frame.readInt16LE(frame.length - 2) / 1000;
    }
    triggered(score) {
        return score !== null && score >= 0.5;
    }
}

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (parent && /localListener\.js$/.test(parent.filename)) {
        if (request === './audio') {
            return {
                Mic: FakeMic,
                playPcm: fakePlayPcm,
                pling: () => Buffer.from('PLING'),
                resolveBackend: () => 'ffmpeg',
            };
        }
        if (request === './wakeword') {
            return { WakeWord: FakeWakeWord };
        }
        if (request === './models') {
            return { ensureModels: async () => ({}) };
        }
    }
    return realLoad.call(this, request, parent, isMain);
};

const { LocalListener, wakePhrases, saysWakeWord } = require(path.join(__dirname, '..', 'build', 'localListener.js'));
const { loadConfig } = require(path.join(__dirname, '..', 'build', 'config.js'));

/** One 80 ms frame: all samples at `level`, the wake score in the last sample */
function frame(level, score = 0) {
    const buf = Buffer.alloc(FRAME_SAMPLES * 2);
    for (let i = 0; i < FRAME_SAMPLES - 1; i++) {
        buf.writeInt16LE(level, i * 2);
    }
    buf.writeInt16LE(Math.round(score * 1000), (FRAME_SAMPLES - 1) * 2);
    return buf;
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20));

/** A listener with a host whose answers the test hands out by hand */
async function makeListener(config = {}) {
    world.plays = [];
    world.resets = 0;
    const host = {
        statuses: [],
        logs: [],
        wakes: 0,
        utterances: [],
        log: {},
        onStatus: state => host.statuses.push(state),
        onWakeWord: () => host.wakes++,
        onUtterance: pcm =>
            new Promise(resolve => {
                host.utterances.push({ pcm, resolve });
            }),
    };
    for (const level of ['debug', 'info', 'warn', 'error']) {
        host.log[level] = msg => host.logs.push(`${level}: ${msg}`);
    }
    const listener = new LocalListener(
        loadConfig({ silenceMs: 160, minRecordMs: 80, maxRecordMs: 4000, silenceThreshold: 300, ...config }),
        host,
    );
    await listener.start();
    const send = async (...frames) => {
        for (const f of frames) {
            world.mic.push(f);
            await settle();
        }
    };
    /** wake word, one loud frame, then silence that ends the recording */
    const ask = async (score = 0.9) => {
        await send(frame(0, score), frame(2000), frame(0), frame(0));
    };
    const status = () => host.statuses[host.statuses.length - 1];
    const replies = () => world.plays.filter(p => !p.beep);
    return { listener, host, send, ask, status, replies };
}

const REPLY = { pcm: Buffer.alloc(4800), sampleRate: 24000 };

describe('LocalListener barge-in', () => {
    it('stops the reply that is playing and listens again', async () => {
        const { listener, host, send, ask, status, replies } = await makeListener();
        await ask();
        assert.equal(host.utterances.length, 1);
        assert.equal(status(), 'processing');
        host.utterances[0].resolve({ ...REPLY, text: 'Es ist zwölf Uhr.' });
        await settle();
        assert.equal(status(), 'speaking');
        assert.equal(replies().length, 1);

        // the mic still runs while the reply plays: the wake word interrupts it
        await send(frame(0, 0.2), frame(0, 0.9));
        assert.equal(replies()[0].killed, true);
        assert.equal(host.wakes, 2);
        assert.equal(status(), 'listening');
        assert.ok(host.logs.some(l => /Barge-in \(score 0\.900\): stopping the reply/.test(l)));

        // the new question runs through normally; the interrupted turn does not set the status
        await send(frame(2000), frame(0), frame(0));
        assert.equal(host.utterances.length, 2);
        assert.equal(status(), 'processing');
        host.utterances[1].resolve(REPLY);
        await settle();
        replies()[1].finish();
        await settle();
        assert.equal(status(), 'idle');
        assert.equal(host.statuses.filter(s => s === 'idle').length, 2, 'start + the end of the second turn');
        await listener.stop();
    });

    it('drops an answer that is still coming', async () => {
        const { listener, host, send, ask, status, replies } = await makeListener();
        await ask();
        assert.equal(status(), 'processing');
        await send(frame(0, 0.95));
        assert.equal(status(), 'listening');
        assert.ok(host.logs.some(l => /dropping the answer that is still coming/.test(l)));

        // the late answer is not played and changes nothing
        host.utterances[0].resolve(REPLY);
        await settle();
        assert.equal(replies().length, 0);
        assert.equal(status(), 'listening');
        assert.ok(host.logs.some(l => /Answer of an interrupted utterance dropped/.test(l)));

        await send(frame(2000), frame(0), frame(0));
        host.utterances[1].resolve(null);
        await settle();
        assert.equal(status(), 'idle');
        await listener.stop();
    });

    it('does nothing of this with bargeIn off', async () => {
        const { listener, host, send, ask, status, replies } = await makeListener({ bargeIn: false });
        await ask();
        const before = world.processed;
        await send(frame(0, 0.99));
        assert.equal(world.processed, before, 'the model is not even asked while busy');
        host.utterances[0].resolve(REPLY);
        await settle();
        await send(frame(0, 0.99));
        assert.equal(replies()[0].killed, false);
        assert.equal(status(), 'speaking');
        replies()[0].finish();
        await settle();
        assert.equal(status(), 'idle');
        assert.equal(host.utterances.length, 1);
        await listener.stop();
    });

    it('needs bargeInThreshold while the reply plays, the normal threshold otherwise', async () => {
        const { listener, host, send, ask, status, replies } = await makeListener({ bargeInThreshold: 0.8 });
        await ask(0.6); // idle: 0.6 is enough
        host.utterances[0].resolve(REPLY);
        await settle();
        await send(frame(0, 0.7));
        assert.equal(replies()[0].killed, false, '0.7 < 0.8 while speaking');
        await send(frame(0, 0.85));
        assert.equal(replies()[0].killed, true);
        assert.equal(status(), 'listening');
        await listener.stop();
    });

    it('does not let a reply that says the wake word interrupt itself', async () => {
        const { listener, host, send, ask, status, replies } = await makeListener({
            wakewordModel: '/data/models/io_broker.onnx',
        });
        await ask();
        host.utterances[0].resolve({ ...REPLY, text: 'Das macht der io Broker für dich.' });
        await settle();
        await send(frame(0, 0.99));
        assert.equal(replies()[0].killed, false);
        assert.equal(status(), 'speaking');
        replies()[0].finish();
        await settle();
        assert.equal(status(), 'idle');
        // the next reply without the word can be interrupted again
        await ask();
        host.utterances[1].resolve({ ...REPLY, text: 'Licht ist an.' });
        await settle();
        await send(frame(0, 0.99));
        assert.equal(replies()[1].killed, true);
        await listener.stop();
    });

    it('forgets what the model heard of the reply', async () => {
        const { listener, host, send, ask, replies } = await makeListener();
        await ask();
        host.utterances[0].resolve(REPLY);
        await settle();
        replies()[0].finish();
        await settle();
        const resets = world.resets;
        await send(frame(0, 0.1));
        assert.equal(world.resets, resets + 1, 'reset before the first frame after the turn');
        await send(frame(0, 0.1));
        assert.equal(world.resets, resets + 1, 'only once');
        await listener.stop();
    });

    it('keeps the follow-up window after a reply that was not interrupted', async () => {
        const { listener, host, send, ask, status, replies } = await makeListener();
        await ask();
        host.utterances[0].resolve({ ...REPLY, listen: true });
        await settle();
        replies()[0].finish();
        await settle();
        assert.equal(status(), 'listening');
        // speech without the wake word starts the answer
        await send(frame(2000), frame(0), frame(0));
        assert.equal(host.utterances.length, 2);
        await listener.stop();
    });
});

describe('wake phrases', () => {
    it('derives them from the model names', () => {
        assert.deepEqual(wakePhrases(''), ['jarvis']);
        assert.deepEqual(wakePhrases('hey_jarvis, alexa'), ['jarvis', 'alexa']);
        assert.deepEqual(wakePhrases('/opt/x/models/io_broker.onnx'), ['iobroker']);
        assert.deepEqual(wakePhrases('C:\\models\\hey_mycroft_v0.1.onnx'), ['mycroft']);
    });

    it('finds them in a reply', () => {
        assert.equal(saysWakeWord('Das kann ioBroker.', ['iobroker']), true);
        assert.equal(saysWakeWord('Frag den io-Broker', ['iobroker']), true);
        assert.equal(saysWakeWord('Das Licht ist an.', ['iobroker', 'jarvis']), false);
        assert.equal(saysWakeWord(undefined, ['jarvis']), false);
    });
});
