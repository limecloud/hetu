#!/usr/bin/env python3
"""离线核对按题材分发、分类出处、任务方法与安装范围。"""
import hashlib
import json
import re
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parent.parent
LINK = re.compile(r'\[[^\]\n]+\]\((<?[^\s)]+>?)\)')


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def headings(text):
    result, seen, fence = set(), {}, None
    for line in text.splitlines():
        marker = re.match(r'^\s*(`{3,}|~{3,})', line)
        if marker:
            if fence is None:
                fence = marker[1][0]
            elif fence == marker[1][0]:
                fence = None
            continue
        if fence is not None:
            continue
        title = re.match(r'^#{1,6}\s+(.+?)\s*#*$', line)
        if title:
            slug = re.sub(r'[^\w\s-]', '', title[1].lower()).replace(' ', '-')
            count = seen.get(slug, 0)
            seen[slug] = count + 1
            result.add(slug + (f'-{count}' if count else ''))
    return result


def inspect(package, suite, skills):
    files = [p for p in package.rglob('*') if p.is_file()]
    require(all(not p.is_symlink() for p in package.rglob('*')), f'{package}: 不允许符号链接')
    require(len(files) <= 256 and all(p.stat().st_size <= 1_048_576 for p in files), f'{package}: 超出安装或读取预算')
    require(sorted(p.parent.name for p in package.rglob('SKILL.md')) == sorted(skills), f'{package}: 任务发现入口不匹配')
    manifest = json.loads((package / 'plugin.json').read_text())
    require(manifest['name'] == suite['pluginName'], f'{package}: 插件身份不符')
    require(re.fullmatch(r'\d+\.\d+\.\d+', manifest['version']), f'{package}: 版本无效')
    inventory = json.loads((package / 'references/method-manifest.json').read_text())
    require(inventory['suite_id'] == suite['id'] and inventory['version'] == manifest['version'] and inventory['language'] == 'zh-CN', f'{package}: 方法清单不符')
    listed = inventory['files']
    actual = {p.relative_to(package).as_posix() for p in files} - {'references/method-manifest.json'}
    require(set(listed) == actual, f'{package}: 包含未声明或缺失的分发文件')
    require(all(sha(package / p) == digest for p, digest in listed.items()), f'{package}: 方法内容摘要不符')
    require(not any(part in p.parts for p in files for part in ['screenwriting', 'story', 'webnovel', 'bookflow']), f'{package}: 仍然携带上游整库')
    require(not (package / 'catalog.json').exists(), f'{package}: 不应将软件分类目录装入Agent')
    required = sorted(p.relative_to(package).as_posix() for p in files if p.relative_to(package).parts[0] in ('references', 'licenses')) + ['THIRD_PARTY_NOTICES.md']
    require(suite['requiredFiles'] == required, f'{package}: 安装完整性目录不符')
    for method in skills:
        text = (package / 'skills' / method / 'SKILL.md').read_text()
        require(text.startswith('---\n') and '\n---\n' in text[4:], f'{method}: frontmatter缺失')
        front = text.split('---', 2)[1]
        require(f'\nname: {method}\n' in front and '\ndescription:' in front and re.search(r'[\u3400-\u9fff]', front), f'{method}: 发现元数据不符')
        require('../../references/genre.md' in text, f'{package}: 任务未接题材方法')
    provenance = json.loads((package / 'references/sources.json').read_text())
    for source in provenance['sources']:
        require(re.fullmatch(r'[0-9a-f]{40}', source['commit']), f'{package}: 来源未固定')
        require(all(re.fullmatch(r'[0-9a-f]{64}', f['sha256']) for f in source['reviewedFiles']), f'{package}: 对照原文摘要缺失')
        if source['decision'] == 'comparison-only':
            require('license_file' not in source, f'{package}: 仅对照来源不应伪称复制许可')
        else:
            license_file = package / source['license_file']
            require(source['license'] == 'MIT' and sha(license_file) == source['license_sha256'], f'{package}: 许可不符')
            require('Copyright' in license_file.read_text() and 'Permission is hereby granted' in license_file.read_text(), f'{package}: 缺原版权许可')
    graph = {}
    for path in files:
        if path.suffix != '.md':
            continue
        text = path.read_text()
        title = re.search(r'^# (.+)', text, re.M)
        require(title is not None and re.search(r'[\u3400-\u9fff]', title[1]), f'{path}: 主标题未中文化')
        graph[path.resolve()] = []
        for target in LINK.findall(text):
            url = urlsplit(target.strip('<>'))
            if url.scheme or url.netloc:
                continue
            linked = (path.parent / unquote(url.path)).resolve() if url.path else path.resolve()
            require(linked.is_relative_to(package.resolve()) and linked.is_file(), f'{path}: 本地引用缺失或越界：{target}')
            if url.fragment:
                require(unquote(url.fragment) in headings(linked.read_text()), f'{path}: 本地锚点失效：{target}')
            graph[path.resolve()].append(linked)
    visited, pending = set(), [(package / 'skills' / s / 'SKILL.md').resolve() for s in skills]
    while pending:
        current = pending.pop()
        if current not in visited:
            visited.add(current)
            pending.extend(graph.get(current, []))
    methods = {p.resolve() for p in (package / 'references').rglob('*.md')}
    require(methods <= visited, f'{package}: 存在任务不可达的方法')
    return len(files), sum(p.stat().st_size for p in files)


def main():
    catalog = json.loads((ROOT / 'integrations/catalog.json').read_text())
    suites = catalog['suites']
    ids = {s['id'] for s in suites}
    require(len(ids) == len(suites) and len({s['pluginName'] for s in suites}) == len(suites), '套件身份重复')
    total_files = total_bytes = 0
    for suite in suites:
        count, size = inspect(ROOT / 'integrations/codex' / suite['pluginName'], suite, catalog['skills'])
        total_files += count
        total_bytes += size
    nodes = {n['id']: n for n in catalog['categories']}
    require(len(nodes) == len(catalog['categories']), '分类节点ID重复')
    evidence = {e['id']: e for e in catalog['classificationEvidence']}
    for node in nodes.values():
        require(set(node['suiteIDs']) <= ids and node['evidenceID'] in evidence, '分类映射或来源失效：' + node['path'])
        require(node['kind'] != 'main' or node['suiteIDs'], '主分类没有对应方法：' + node['path'])
        require(node['channel'] in ('male', 'female', 'shared'), '频道维度失效')
        chain, current = set(), node
        while current['parentID'] is not None:
            require(current['id'] not in chain and current['parentID'] in nodes, '分类父子失效或成环')
            chain.add(current['id'])
            parent = nodes[current['parentID']]
            require(parent['platform'] == node['platform'] and parent['channel'] == node['channel'], '分类串平台或频道')
            current = parent
    require(evidence['qdmm-unverified']['kind'] == 'unavailable', '不应把起点女生挑战页当成已核实分类')
    # 验证实际作品选型的关键分歧，而非用标签数量宣称覆盖质量。
    def find(platform, channel, name, fragment):
        matches = [n for n in nodes.values() if n['platform'] == platform and n['channel'] == channel and n['name'] == name and fragment in n['path']]
        require(len(matches) == 1, '场景分类不唯一：' + name)
        return matches[0]['suiteIDs']
    require(find('fanqie', 'female', '科幻末世', '主分类') == ['apocalypse', 'scifi'], '女频科幻末世被误配言情')
    require(find('qidian', 'male', '无限', '诸天无限') == ['infinite'], '无限副本机制未路由')
    require(find('fanqie', 'female', '古风世情', '主分类') == ['historical-life'], '古风世情被误等同古言恋爱')
    require(find('fanqie', 'male', '都市日常', '主分类') == ['urban-daily'], '都市日常被误配升级打脸')
    require(find('fanqie', 'shared', '无CP', '情感') == [], '无CP是作品约束，不能当作必须额外安装的题材包')
    military = (ROOT / 'integrations/codex/hetu-military/references/genre.md').read_text()
    apocalypse = (ROOT / 'integrations/codex/hetu-apocalypse/references/genre.md').read_text()
    require('补给' in military and '通信' in military and '伤亡' in military, '军事专项缺关键约束')
    require('无CP' in apocalypse and '资源' in apocalypse and '运输' in apocalypse, '末世专项缺资源与无CP约束')
    print(f'{len(suites)}套件/{total_files}文件/{total_bytes:,}字节，{len(nodes)}分类节点：引用、来源、中文、隔离分发与选型场景通过')


if __name__ == '__main__':
    main()
