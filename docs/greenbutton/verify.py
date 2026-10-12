#!/usr/bin/env python3
"""Offline reconciliation of the docs-owned Green Button evidence corpus.

Does NOT certify ESPI, validate utility XML against XSD, or test production
features not already covered by named Vitest tests. No third-party dependency.
"""
from pathlib import Path
import argparse
import copy
import hashlib
import json
import re
import unittest
import xml.etree.ElementTree as ET

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
NS = {'x': 'http://www.w3.org/2001/XMLSchema'}
STATUSES = {'fully parsed+used', 'parsed+preserved', 'explicitly unsupported',
            'not applicable to our third-party role'}


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read(name):
    return json.loads((HERE / name).read_text())


def schema_inventory(path):
    root = ET.parse(path).getroot()
    types = []
    for node in root.findall('x:complexType', NS) + root.findall('x:simpleType', NS):
        types.append({
            'name': node.get('name'),
            'kind': node.tag.rsplit('}', 1)[-1],
            'bases': [x.get('base') for x in node.iter() if x.get('base')],
            'fields': [dict(x.attrib) for x in node.findall('.//x:element', NS)],
            'attributes': [dict(x.attrib) for x in node.findall('.//x:attribute', NS)],
            'enumerations': [dict(value=x.get('value'),
                                  documentation=' '.join(''.join(x.itertext()).split()))
                             for x in node.findall('.//x:enumeration', NS)],
        })
    return {'namespace': root.get('targetNamespace'), 'version': root.get('version'),
            'globals': [dict(x.attrib) for x in root.findall('x:element', NS)],
            'types': types}


def reconcile(schemas, matrix):
    expected_globals = {(s['file'], e['name'], e['type'].split(':')[-1])
                        for s in schemas for e in s['globals']}
    actual_globals = [(r['schema'], r['element'], r['type']) for r in matrix['globals']]
    assert len(actual_globals) == len(set(actual_globals)), 'duplicate global matrix row'
    assert set(actual_globals) == expected_globals, 'global inventory/matrix mismatch'
    expected_types = {(s['file'], t['name']): t for s in schemas for t in s['types']
                      if t['kind'] == 'complexType'}
    actual_types = {(r['schema'], r['type']): r for r in matrix['complex_types']}
    assert len(actual_types) == len(matrix['complex_types']), 'duplicate type matrix row'
    assert set(expected_types) == set(actual_types), 'complex-type inventory/matrix mismatch'
    for key, expected in expected_types.items():
        names = [f.get('name') or f.get('ref') for f in expected['fields']]
        assert names == [f['name'] for f in actual_types[key]['fields']], f'field mismatch: {key}'
    return len(expected_globals), len(expected_types)


def check():
    schemas = read('schema-inventory.json')
    for s in schemas:
        assert sha(HERE / s['file']) == s['sha256'], f"schema hash drift: {s['file']}"
        fresh = schema_inventory(HERE / s['file'])
        for key in ['namespace', 'version', 'globals', 'types']:
            assert fresh[key] == s[key], f"schema extraction drift: {s['file']} {key}"
    matrix = read('support-matrix.json')
    global_count, type_count = reconcile(schemas, matrix)
    gaps = {g['id']: g for g in read('gaps.json')}
    features = {f['id']: f for f in read('features.json')}
    recipes = {r['id']: r for r in read('fixture-manifest.json')['synthetic_recipes']}
    assert len(gaps) == len(read('gaps.json')), 'duplicate gap id'
    assert len(features) == len(read('features.json')), 'duplicate feature id'
    for g in gaps.values():
        assert g['phase'] in ['P0', 'P1', 'P2', 'P3', 'P4']
        assert all(g[k] for k in ['impact', 'acceptance_test', 'source', 'criteria'])
        assert g['fixture'] in recipes
        assert recipes[g['fixture']]['gap'] == g['id']
        assert recipes[g['fixture']]['acceptance_test'] == g['acceptance_test']
    mapped_tests = set()
    for f in features.values():
        assert f['status'] in STATUSES
        assert f['gap'] in gaps and f['supported_scope']
        if f['status'] in ['fully parsed+used', 'parsed+preserved']:
            assert f['existing_tests'], f"unproven supported feature: {f['id']}"
        for test in f['existing_tests']:
            text = (REPO / test['path']).read_text()
            # Exact title exists, including parameterised describe.each tests.
            titles = re.findall(r"\b(?:it|test)\s*\(\s*(['\"])(.*?)\1", text)
            assert test['title'] in [t for _, t in titles], f"missing executable test: {test}"
            mapped_tests.add((test['path'], test['title']))
    rows = matrix['globals'] + matrix['complex_types'] + read('function-block-matrix.json')
    for row in rows:
        assert row['status'] in STATUSES
        assert row['gap'] in gaps and row['phase']
        assert all(x in features for x in row['implemented_features'])
        if row['status'] == 'not applicable to our third-party role':
            assert row['note']
    for row in matrix['complex_types']:
        for field in row['fields']:
            assert field['status'] in STATUSES and field['gap'] in gaps
            assert field['feature'] is None or field['feature'] in features
    cat = read('function-block-sources.json')
    assert len(cat['current_page']['entries']) > 40, 'empty/partial GBA website catalog'
    assert sha(HERE / 'function-block-catalog.java.txt') == cat['java']['sha256']
    text = (HERE / 'function-block-catalog.java.txt').read_text()
    active = {int(i) for i in re.findall(r'FB_\d+\((\d+),', text)}
    deprecated = {int(i) for i in re.search(r'Set.of\(([^)]+)\)', text).group(1).split(',')}
    expected_fb = active | deprecated | {e['id'] for e in cat['current_page']['entries']} | {e['id'] for e in cat['legacy']['entries']}
    actual_fb = [x['id'] for x in read('function-block-matrix.json')]
    assert len(actual_fb) == len(set(actual_fb)), 'duplicate function block'
    assert expected_fb == set(actual_fb), 'function block inventory/matrix mismatch'
    for row in read('function-block-matrix.json'):
        expected_state = 'active' if row['id'] in active else 'deprecated' if row['id'] in deprecated else 'not enumerated'
        assert row['java_state'] == expected_state
        assert row['source_urls']
    fixture_count = 0
    for fx in read('fixture-manifest.json')['fixtures']:
        assert fx['provenance'] and fx['sha256'] and fx['kind']
        if fx.get('local_path'):
            expected = fx.get('local_sha256', fx['sha256'])
            assert sha(REPO / fx['local_path']) == expected, f"fixture bytes drift: {fx['id']}"
        fixture_count += 1
    report = dict(audited_code_commit=matrix['audited_code_commit'],schemas=len(schemas),
                  global_rows=global_count,complex_type_rows=type_count,
                  field_rows=sum(len(t['fields']) for t in matrix['complex_types']),
                  function_blocks=len(actual_fb),java_active=len(active),java_deprecated=len(deprecated),
                  supported_features=len(features),mapped_test_titles=len(mapped_tests),
                  fixture_references=fixture_count,proposed_acceptance_tests=len(gaps),
                  result='PASS: inventory reconciliation; NOT standards certification')
    print(json.dumps(report, indent=2))
    return report


class ReconciliationAdversarialTests(unittest.TestCase):
    def setUp(self):
        self.schemas = read('schema-inventory.json')
        self.matrix = read('support-matrix.json')

    def test_baseline_matches(self):
        reconcile(self.schemas, self.matrix)

    def test_missing_resource_rejected(self):
        self.matrix['globals'].pop()
        with self.assertRaisesRegex(AssertionError, 'global inventory'):
            reconcile(self.schemas, self.matrix)

    def test_duplicate_resource_rejected(self):
        self.matrix['globals'].append(copy.deepcopy(self.matrix['globals'][0]))
        with self.assertRaisesRegex(AssertionError, 'duplicate global'):
            reconcile(self.schemas, self.matrix)

    def test_missing_complex_type_rejected(self):
        self.matrix['complex_types'].pop()
        with self.assertRaisesRegex(AssertionError, 'complex-type inventory'):
            reconcile(self.schemas, self.matrix)

    def test_missing_field_rejected(self):
        next(r for r in self.matrix['complex_types'] if r['fields'])['fields'].pop()
        with self.assertRaisesRegex(AssertionError, 'field mismatch'):
            reconcile(self.schemas, self.matrix)

    def test_foreign_namespace_not_collapsed(self):
        names = {(s['namespace'], e['name']) for s in self.schemas for e in s['globals']}
        self.assertIn(('http://naesb.org/espi', 'UsagePoint'), names)
        self.assertIn(('http://naesb.org/espi/customer', 'UsagePoint'), names)

    def test_draft_version_not_assumed_published(self):
        s = next(s for s in self.schemas if s['file'] == 'customer-v4.1.xsd')
        self.assertEqual(s['role'], 'unverified-draft-delta')
        self.assertEqual(s['version'], '4.0')
        self.assertIn('Published Pending', (HERE / s['file']).read_text())


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--self-test', action='store_true')
    args = parser.parse_args()
    if args.self_test:
        outcome = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(ReconciliationAdversarialTests))
        if not outcome.wasSuccessful():
            raise SystemExit(1)
    check()
