// The dashboard widget: valid for the core, bound to features that exist.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { WIDGET_KEY } from '../src/monitor.js';
import { STATION, create, createWorld, packetsOf, replay, RECORDING } from './helpers/world.js';

async function content(world, request = {}) {
  const ack = await world.fake.widgetGet(WIDGET_KEY, { language: 'fr', ...request });
  return ack.data.content;
}

function check(content, device) {
  assert.deepEqual(validateWidgetContent(content).errors ?? [], []);
  const ids = new Set(device ? device.features.map((feature) => feature.external_id) : []);
  for (const component of content.components) {
    for (const id of [component.device_feature, ...(component.device_features ?? [])].filter(
      Boolean,
    )) {
      assert.ok(ids.has(id), `${id} is not a feature of the device`);
    }
  }
}

test('the station added, UDP on: name, tiles, chart and status, within the budget', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const device = await create(world);
  await replay(world, packetsOf(RECORDING, { to: 100 }));
  const widget = await content(world);
  check(widget, device);
  assert.deepEqual(
    widget.components.map((component) => component.type),
    ['text', 'value', 'value', 'chart', 'status'],
  );
  assert.equal(widget.components[0].text, `Raspberry Shake ${STATION}`);
  assert.deepEqual(
    widget.components.at(-1).items.map((item) => [item.label, item.value]),
    [
      ['Station', 'En ligne'],
      ['Dernière donnée', '03/08 08:50'],
      ['Sol', 'Secousse'],
      ['UDP (1 min)', '240 paquets'],
    ],
  );
  const hidden = await content(world, { settings: { show_chart: false }, language: 'de' });
  assert.ok(!hidden.components.some((component) => component.type === 'chart'));
});

test('the station not added yet, or without UDP, or without a code', async (t) => {
  const world = await createWorld({ config: { station: STATION, udp: false } });
  t.after(() => world.app.stop());
  const widget = await content(world, { language: 'en' });
  check(widget);
  assert.deepEqual(
    widget.components.map((component) => component.type),
    ['text', 'text', 'status'],
  );
  assert.match(widget.components[1].text, /Discovery tab/);
  const empty = await createWorld({ config: {} });
  t.after(() => empty.app.stop());
  const none = await content(empty, { language: 'es' });
  check(none);
  assert.equal(none.components[0].text, 'Ninguna estación configurada');
});
