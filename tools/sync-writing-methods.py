#!/usr/bin/env python3
"""从河图中文唯一源生成按题材选择的独立 Skills；离线、不执行上游代码。"""
import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'tools/hetu-skills'
VERSION = '0.2.1'
SKILLS = ['hetu-setup', 'hetu-book-create', 'hetu-book-profile', 'hetu-outline', 'hetu-cover', 'hetu-draft', 'hetu-revise', 'hetu-drama']


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def taxonomy(genres):
    snapshots = json.loads((SOURCE / 'platform-snapshots.json').read_text())
    aliases = {}
    for genre in genres:
        for term in [genre['name'], *genre['aliases']]:
            aliases.setdefault(term, []).append(genre['id'])
    # 平台的组合主类不等同单一创作方法；提供候选而非要求同时安装。
    overrides = {'科幻末世': ['apocalypse', 'scifi'], '游戏体育': ['gaming', 'sports', 'esports'],
                 '玄幻仙侠': ['xuanhuan', 'xianxia'], '纯爱': ['modern-romance', 'danmei', 'baihe']}
    categories = []
    def node(id_, parent, name, platform, channel, kind, path, suites, evidence):
        categories.append(dict(id=id_, parentID=parent, name=name, platform=platform, channel=channel,
                               kind=kind, path=path, suiteIDs=list(dict.fromkeys(suites)), evidenceID=evidence))
    def routes(name):
        return overrides.get(name, aliases.get(name, []))
    for category in snapshots['qidian']:
        parent = 'qidian:male:class:' + category['id']
        label = '起点中文网 / 男频 / ' + category['name']
        ids = routes(category['name'])
        if not ids:
            raise ValueError('起点主类缺少方法映射：' + category['name'])
        node(parent, None, category['name'], 'qidian', 'male', 'main', label, ids, 'qidian-mobile-20261113')
        for child in category['children']:
            node(parent + ':sub:' + child['id'], parent, child['name'], 'qidian', 'male', 'sub', label + ' / ' + child['name'], routes(child['name']) or ids, 'qidian-mobile-20261113')
    for source, sections in snapshots['fanqie'].items():
        channel = 'male' if source.endswith('male') and not source.endswith('female') else 'female' if source.endswith('female') else 'shared'
        form = '短篇' if source == 'fanqie-short' else '长篇'
        dimension = '阅读标签' if 'reading' in source else '内容标签' if 'content' in source else '作品分类'
        channel_name = {'male': '男频', 'female': '女频', 'shared': '通用'}[channel]
        for section in sections:
            field = section['field']
            group = source + ':' + sha(field.encode())[:10]
            label = f'番茄小说 / {form} / {channel_name} / {dimension} / {field}'
            all_ids = [id_ for name in section['labels'] for id_ in routes(name)]
            node(group, None, field, 'fanqie', channel, 'field', label, all_ids, source)
            for name in section['labels']:
                ids = routes(name)
                if source == 'fanqie-short' and field == '主分类':
                    ids = list(dict.fromkeys([*ids, 'short-story']))
                if field == '主分类' and not ids:
                    raise ValueError('番茄主类缺少方法映射：' + name)
                node(group + ':' + sha(name.encode())[:12], group, name, 'fanqie', channel,
                     'main' if field == '主分类' else 'tag', label + ' / ' + name, ids, source)
    return categories


def genre_document(genre):
    fields = [('建书与定位', 'promise'), ('作品资料', 'profile'), ('大纲与长期推进', 'planning'),
              ('章节起草与续写', 'draft'), ('改稿与专项复核', 'review'), ('封面', 'cover'), ('短剧改编', 'adaptation')]
    text = [f"# {genre['name']}题材方法\n", f"本包只服务作者选定的{genre['name']}方向；下列增量分别结合当前任务工作法使用。\n",
            '共用的[任务合同](task-contract.md)决定权限与交付；题材约定不扩大读取或修改范围。男频、女频是读者频道，不决定视角、人物性别、CP和结局。\n',
            '## 固定输入与设定依据\n', genre['facts'] + '\n',
            '缺失材料只阻断依赖它的判断。作者已确认的规则优先；新机制、新关系、资料考据和重大改线分别作为候选，不写成已确认事实。\n']
    for title, key in fields:
        text += ['## ' + title + '\n', genre[key] + '\n']
    text += ['## 复核问题\n', *['- ' + question for question in genre['checks']], '\n## 诊断示例\n', genre['example'] + '\n',
             '## 交叉题材与作者约定\n',
             '本包是主要体验的方法，不会因平台标签自动添加其他类型套路。复合题材先明确当前任务以什么体验为主、次要机制改变哪些条件；无CP、关系结构、篇幅和基调沿用作者约定。超出本包的问题可说明需要另一套件，由作者在河图选择；不扫描或自动安装全部题材。短篇压缩支线与重复过程，保留动机、因果和结局回收。\n',
             '把专项诊断留在允许的说明中。正文候选、资料字段、封面资产和 Fountain 仍按各自工作法提交；本次结果不自动成为正式作品内容。\n']
    return '\n'.join(text).encode()


def render():
    genres = json.loads((SOURCE / 'genres.json').read_text())
    assert len({g['id'] for g in genres}) == len(genres)
    provenance = json.loads((SOURCE / 'sources.json').read_text())
    shared = {p.relative_to(SOURCE / 'base').as_posix(): p.read_bytes() for p in sorted((SOURCE / 'base').rglob('*')) if p.is_file()}
    for path in (SOURCE / 'licenses').glob('*.txt'):
        shared['licenses/' + path.name] = path.read_bytes()
    shared['references/sources.json'] = encoded({k: v for k, v in provenance.items() if k != 'classificationEvidence'})
    shared['references/writing-methods.md'] = '''# 河图洛书任务与方法导航

每次只读当前任务的一份工作法，再结合[本包题材方法](genre.md)的相应环节。不要通读所有资料或叠加其他已安装包的类型约定。

| 任务 | 工作法 |
| --- | --- |
| 建书方向与初步定位 | [建书构思](workflows/creation.md) |
| 书名、简介与卖点 | [作品资料](workflows/profile.md) |
| 总纲、卷纲、章纲 | [大纲规划](workflows/outline.md) |
| 起草、续写 | [章节写作](workflows/draft.md) |
| 选区改稿、公开意见返工 | [诊断与改稿](workflows/revision.md) |
| 小说改编 Fountain | [改编](workflows/adaptation.md) |
| 封面候选 | [封面](workflows/cover.md) |

卡点涉及人物、关系或知情边界时读[人物与视角](craft/characters.md)；长线、单元与伏笔读[结构与回收](craft/structure.md)；场景、对白与文风读[场景语言](craft/scenes.md)；资源、地理、时间与资料核验读[世界规则](craft/worldbuilding.md)。这些是跨题材的必要工艺，不是额外安装的题材库。

作者的视角、篇幅、语言、关系、结局、基调和修改范围优先。方法不强制每章反转、失败或悬崖，不默认男频升级、女频恋爱。参考工程的外部CLI、文件写回、记忆库、自动发布与强制多Agent流程不在河图执行。作品事实归Core，结果始终为候选。

上游对照版本与许可见[来源记录](sources.json)和[第三方说明](../THIRD_PARTY_NOTICES.md)。完整平台分类在河图的软件目录，用于查找和选择套件，不随题材包全量安装。
'''.encode()
    notices = ['# 方法来源与许可\n', '本包按河图洛书任务合同重新编写共用工艺与题材方法，不分发上游整库。以下固定版本用于方法对照与取舍，原许可按涉及来源保留。来源摘要见[来源记录](references/sources.json)；GPL或无明确许可的项目只作对照，不复制其正文、代码或分类表。\n']
    for record in provenance['sources']:
        link = record['repository'] + '/tree/' + record['commit']
        notices.append(f"- [{record['id']}]({link})：{record['license'] or '未声明许可'}；" + (f"[原版权与许可]({record['license_file']})。" if record.get('license_file') else record['reason']))
    shared['THIRD_PARTY_NOTICES.md'] = ('\n'.join(notices) + '\n').encode()
    packages, suites = {}, []
    for genre in genres:
        name = 'hetu' if genre['id'] == 'general' else 'hetu-' + genre['id']
        output = dict(shared)
        for method in SKILLS:
            key = f'skills/{method}/SKILL.md'
            # 发现描述限定作者所选题材，避免多个套件在同一宿主中误路由。
            output[key] = output[key].decode().replace('description: "', f'description: "作者选择河图洛书{genre["name"]}套件时，', 1).encode()
        output['plugin.json'] = encoded({'$schema': 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', 'name': name, 'version': VERSION, 'description': '河图洛书'+genre['name']+'创作套件：八个任务与本题材方法，按作品选择安装'})
        output['hetu-suite.json'] = encoded({'schema_version': '1.0.0', 'suite_id': genre['id']})
        output['references/genre.md'] = genre_document(genre)
        output['references/method-manifest.json'] = encoded({'schema_version': '1.0.0', 'suite_id': genre['id'], 'version': VERSION, 'language': 'zh-CN', 'files': {p: sha(b) for p, b in sorted(output.items())}})
        packages[name] = output
        suites.append(dict(id=genre['id'], pluginName=name, titleKey='agent.suite.'+genre['id'], family=genre['family'],
                           summary=genre['promise'], aliases=list(dict.fromkeys([genre['name'], *genre['aliases']])),
                           requiredFiles=sorted(p for p in output if p.startswith(('references/', 'licenses/'))) + ['THIRD_PARTY_NOTICES.md']))
    catalog = dict(schemaVersion='1.0.0', skills=SKILLS, suites=suites, categories=taxonomy(genres),
                   classificationEvidence=provenance['classificationEvidence'])
    return packages, catalog


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='只核对可复现产物，不写入')
    args = parser.parse_args()
    packages, catalog = render()
    for name, expected in packages.items():
        directory = ROOT / 'integrations/codex' / name
        actual = {p.relative_to(directory).as_posix(): p for p in directory.rglob('*') if p.is_file()}
        if args.check:
            if actual.keys() != expected.keys() or any(actual[p].read_bytes() != data for p, data in expected.items()):
                raise SystemExit('套件与中文唯一源不一致：' + name)
        else:
            for relative, data in expected.items():
                destination = directory / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(data)
            # 仅清理本工具拥有的题材包旧产物；旧版方法已保存在研究备份与固定commit clone。
            for relative in actual.keys() - expected.keys():
                actual[relative].unlink()
            for child in sorted(directory.rglob('*'), key=lambda p: len(p.parts), reverse=True):
                if child.is_dir() and not any(child.iterdir()):
                    child.rmdir()
    destination = ROOT / 'integrations/catalog.json'
    data = encoded(catalog)
    if args.check:
        if destination.read_bytes() != data:
            raise SystemExit('软件套件目录与中文唯一源不一致')
    else:
        destination.write_bytes(data)
    print(f'{len(packages)} 个独立题材套件、{len(catalog["categories"])} 个有出处分类节点，' + ('离线复现通过' if args.check else '已生成；每次仅安装所选套件'))


if __name__ == '__main__':
    main()
