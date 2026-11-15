// -----------------------------------------------------------------------------
// Consistency checks between `gladys-assistant-integration.json` and the code.
// The manifest is validated by the store indexer, but nothing there can know
// which handlers the code actually registers — these tests keep both in sync.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CONFIG_ACTION } from '../src/app.js';
import { DEFAULT_CONFIG, LANGUAGES, OFFLINE_AFTER, SENSITIVITIES } from '../src/config.js';
import { RECEIVER_CONTAINER, TRIGGERS, WIDGET_KEY } from '../src/monitor.js';
import { UDP_PORT } from '../src/receiver.js';
import { WIDGETS } from '../src/widgets.js';
import {
  RECORDING,
  createArchive,
  createWorld,
  create,
  packetsOf,
  replay,
  tick,
} from './helpers/world.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

const allFields = [
  ...(manifest.config_schema ?? []),
  ...[...(manifest.actions ?? []), ...(manifest.scene_triggers ?? [])].flatMap(
    (item) => item.fields ?? [],
  ),
  ...(manifest.widgets ?? []).flatMap((widget) => widget.settings ?? []),
];

const { gladys: registered, app } = await createWorld({ connect: false });
await app.stop();
const handlerKeys = (prefix) =>
  Object.keys(registered.handlers)
    .filter((key) => key.startsWith(prefix))
    .map((key) => key.slice(prefix.length));

const keysOf = (list) => (list ?? []).map((entry) => entry.key);
const optionValues = (field) => field.options.map((option) => option.value);
const field = (list, key) => list.find((entry) => entry.key === key);

test('identity: name, image, cover, local transport, categories', () => {
  assert.equal(manifest.name, 'Raspberry Shake');
  assert.equal(manifest.type, 'device');
  assert.match(manifest.docker_image, /^ghcr\.io\/guim31\/gladys-raspberry-shake:/);
  assert.equal(
    manifest.cover_image,
    'https://raw.githubusercontent.com/guim31/gladys-raspberry-shake/main/cover.png',
  );
  assert.deepEqual(manifest.transports, ['local']);
  assert.deepEqual(manifest.categories, ['environment', 'security']);
});

test('Gladys 5.2.0 at least: sub-container ports and their placeholder', () => {
  assert.equal(manifest.gladys_version, '>=5.2.0');
});

test('the receiver sub-container runs the same image, its UDP port named for the section', () => {
  assert.equal(manifest.containers.length, 1);
  const [receiver] = manifest.containers;
  assert.equal(receiver.name, RECEIVER_CONTAINER);
  assert.equal(receiver.docker_image, manifest.docker_image);
  assert.deepEqual(receiver.command, ['node', 'src/receiver-main.js']);
  assert.deepEqual(
    receiver.ports.map(({ container_port, protocol, name, browsable }) => ({
      container_port,
      protocol,
      name,
      browsable,
    })),
    [{ container_port: UDP_PORT, protocol: 'udp', name: 'shake_udp', browsable: false }],
  );
  const intro = field(manifest.config_schema, 'intro');
  for (const language of LANGUAGES) {
    assert.match(intro.description[language], /\{\{gladys_host\}\}.*\{\{port:shake_udp\}\}/);
  }
});

test('every manifest action, trigger and widget has its handler, and vice versa', () => {
  assert.deepEqual(keysOf(manifest.actions), [CONFIG_ACTION]);
  assert.deepEqual(handlerKeys('action:'), [CONFIG_ACTION]);
  assert.equal(manifest.scene_actions, undefined);
  assert.deepEqual(handlerKeys('sceneAction:'), []);
  assert.deepEqual(keysOf(manifest.widgets), [WIDGET_KEY]);
  assert.deepEqual(Object.keys(WIDGETS), [WIDGET_KEY]);
  assert.deepEqual(handlerKeys('widget:'), [WIDGET_KEY]);
  assert.deepEqual(keysOf(manifest.scene_triggers).sort(), Object.values(TRIGGERS).sort());
});

test('the scene events fired carry exactly the declared variables', async (t) => {
  const world = await createWorld({
    archive: createArchive({ lastData: RECORDING.start - 3 * 60 * 60 * 1000 }),
  });
  t.after(() => world.app.stop());
  await create(world);
  await replay(world, packetsOf());
  await tick(world, 180);
  const fired = world.fake.sceneEvents;
  assert.deepEqual(fired.map((event) => event.key).sort(), Object.values(TRIGGERS).sort());
  for (const event of fired) {
    const trigger = field(manifest.scene_triggers, event.key);
    const keys = [...keysOf(trigger.fields), ...keysOf(trigger.variables)];
    assert.deepEqual(Object.keys(event.data).sort(), keys.sort(), event.key);
    for (const variable of trigger.variables) {
      assert.equal(typeof event.data[variable.key], variable.type, `${event.key}.${variable.key}`);
    }
  }
});

test('config_schema defaults and options are the ones of the code', () => {
  for (const entry of manifest.config_schema) {
    if (entry.default !== undefined) {
      assert.deepEqual(DEFAULT_CONFIG[entry.key], entry.default, entry.key);
    }
  }
  assert.deepEqual(
    Object.keys(DEFAULT_CONFIG).sort(),
    manifest.config_schema
      .filter((entry) => entry.type !== 'section')
      .map((entry) => entry.key)
      .sort(),
  );
  assert.deepEqual(optionValues(field(manifest.config_schema, 'language')), LANGUAGES);
  assert.deepEqual(
    optionValues(field(manifest.config_schema, 'sensitivity')),
    Object.keys(SENSITIVITIES),
  );
  assert.deepEqual(optionValues(field(manifest.config_schema, 'offline_after')), OFFLINE_AFTER);
});

test('section fields are purely presentational, links in https', () => {
  for (const section of manifest.config_schema.filter((entry) => entry.type === 'section')) {
    assert.equal(section.required, undefined);
    assert.equal(section.default, undefined);
    for (const link of section.links ?? []) {
      assert.match(link.url, /^https:\/\//);
    }
  }
});

test('no number field (the form has no step), no secret anywhere', () => {
  assert.deepEqual(
    allFields.filter((entry) => entry.type === 'number' || entry.type === 'secret'),
    [],
  );
});

test('actions: no field at all (the core applies no default, #3154 and #3155)', () => {
  for (const action of manifest.actions) {
    assert.equal(action.fields, undefined, action.key);
  }
});

test('the manifest version is the package version, and the image is tagged with it', () => {
  assert.equal(manifest.version, pkg.version);
  assert.ok(manifest.docker_image.endsWith(`:${manifest.version}`));
});

test('the catalog description holds 10 to 100 characters per language', () => {
  for (const [lang, text] of Object.entries(manifest.description)) {
    assert.ok(text.length >= 10 && text.length <= 100, `description.${lang}: ${text.length}`);
  }
});
