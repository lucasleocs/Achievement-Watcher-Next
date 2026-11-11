'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const reference = require('../helpers/wineRegistryReference.js');
const candidate = require('../../app/util/wineRegistry.js');

function temporaryHive(t, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-reg-differential-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'user.reg');
  fs.writeFileSync(file, content);
  return file;
}

function fixture() {
  return [
    'WINE REGISTRY Version 2',
    '',
    '[Software\\\\Alpha] 1791978481',
    '#time=01f0000000000000',
    '"DisplayName"="first"',
    '"DISPLAYNAME"="last"',
    '@="default"',
    '"Quoted"="say \\"hello\\""',
    '"Unicode"="caf\\x00e9"',
    '"NativeUtf8"="José"',
    '"Expandable"=str(2):"%USERPROFILE%\\\\Mes documents"',
    '"Count"=dword:0000002a',
    '"HexIgnored"=hex:01,02,' + '\\',
    ' 03,04',
    '"Unsupported"=str(7):"a\\0b"',
    '',
    '[Software\\\\Alpha\\\\SubChild] 1791978482',
    '"Case"="one"',
    '[software\\\\ALPHA\\\\subchild] 1791978483',
    '"case"="two"',
    '[Software\\\\Alpha\\\\unicode\\x00e9]',
    '@="unicode child"',
    '[Software\\\\Zeta]',
    '"Empty"=""',
    '',
    '[Software\\\\Malformed',
    '"ThisShouldBeIgnored"="yes"',
    '',
  ].join('\n');
}

function assertEquivalent(file, keys, values) {
  for (const key of keys) {
    assert.deepEqual(candidate.listSubkeys(file, key), reference.listSubkeys(file, key), 'subkeys: ' + key);
    assert.deepEqual(candidate.listValueNames(file, key), reference.listValueNames(file, key), 'value names: ' + key);
    for (const name of values) {
      assert.deepEqual(candidate.readValue(file, key, name), reference.readValue(file, key, name),
        'value: ' + key + '/' + name);
    }
  }
}

test('the public parseHive API preserves its complete Map representation', () => {
  for (const content of [fixture(), fixture().replace(/\n/g, '\r\n'), '', 'WINE REGISTRY Version 2\n']) {
    assert.deepEqual(candidate.parseHive(content), reference.parseHive(content));
  }
});

test('all file-backed queries agree with the original on positive and negative cases', (t) => {
  const file = temporaryHive(t, fixture());
  const keys = [
    '', 'software', 'Software/Alpha', 'SOFTWARE\\ALPHA', 'Software/Alpha/SubChild',
    'software/alpha/unicodeé', 'software/zeta', 'software/missing', 'Software/Malformed',
  ];
  const values = [
    '', 'displayname', 'DISPLAYNAME', 'Quoted', 'Unicode', 'NativeUtf8', 'Expandable',
    'Count', 'HexIgnored', 'Unsupported', 'Case', 'Empty', 'ThisShouldBeIgnored', 'missing',
  ];
  assertEquivalent(file, keys, values);
  assert.deepEqual(candidate.readValue(file, 'software/alpha', 'displayname'), { type: 'REG_SZ', value: 'last' });
  assert.deepEqual(candidate.readValue(file, 'software/alpha', 'Unicode'), { type: 'REG_SZ', value: 'café' });
  assert.deepEqual(candidate.readValue(file, 'software/alpha', 'Count'), { type: 'REG_DWORD', value: 42 });
  assert.equal(candidate.readValue(file, 'software/alpha', 'HexIgnored'), null);
  assert.deepEqual(candidate.listSubkeys(file, 'software/alpha'), ['subchild', 'unicodeé']);
  assert.deepEqual(candidate.listValueNames(file, 'software/alpha'),
    ['DISPLAYNAME', '', 'Quoted', 'Unicode', 'NativeUtf8', 'Expandable', 'Count']);
});

test('changed and removed files preserve the original missing-file and invalidation behavior', (t) => {
  const file = temporaryHive(t, fixture());
  assert.deepEqual(candidate.readValue(file, 'software/alpha', 'displayname'),
    reference.readValue(file, 'software/alpha', 'displayname'));

  const changed = fixture().replace('"DISPLAYNAME"="last"', '"DISPLAYNAME"="a new, longer value"');
  fs.writeFileSync(file, changed);
  assertEquivalent(file, ['software/alpha', 'software/alpha/subchild'], ['displayname', 'Case']);
  assert.deepEqual(candidate.readValue(file, 'software/alpha', 'displayname'),
    { type: 'REG_SZ', value: 'a new, longer value' });

  fs.unlinkSync(file);
  assertEquivalent(file, ['', 'software/alpha'], ['', 'displayname']);
  assert.equal(candidate.readValue(file, 'software/alpha', 'displayname'), null);
});

test('a large synthetic hive preserves enumeration order, aliases and non-ASCII values', (t) => {
  const sections = ['WINE REGISTRY Version 2', ''];
  for (let i = 0; i < 2400; i++) {
    sections.push('[Software\\\\Generated\\\\Item' + i + '] 1791978481');
    sections.push('"Name"="record-' + i + '-José"');
    sections.push('"Counter"=dword:' + i.toString(16).padStart(8, '0'));
    if (i % 31 === 0) sections.push('"Other"=hex:01,02,03');
  }
  const content = sections.join('\r\n') + '\r\n';
  const file = temporaryHive(t, content);
  const keys = ['', 'Software/Generated', 'Software/Generated/Item0',
    'Software/Generated/Item31', 'Software/Generated/Item2399', 'Software/Absent'];
  assert.deepEqual(candidate.parseHive(content), reference.parseHive(content));
  assertEquivalent(file, keys, ['', 'Name', 'Counter', 'Other']);
  const names = candidate.listSubkeys(file, 'Software/Generated');
  assert.equal(names.length, 2400);
  assert.equal(names[0], 'Item0');
  assert.equal(names[2399], 'Item2399');
});
