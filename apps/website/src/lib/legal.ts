import type { Locale } from './site';

type Policy = { title: string; description: string; sections: { title: string; paragraphs: string[] }[] };
export const policies: Record<Locale, Record<'privacy' | 'terms', Policy>> = {
  'zh-CN': {
    privacy: {
      title: '隐私政策',
      description: '河图洛书本地作品、账号连接和可选模型服务的数据处理说明。',
      sections: [
        { title: '本地作品与外部 Agent', paragraphs: ['小说、剧本、设定与候选保存在你选择的本地作品目录。连接河图账号不会自动上传整个作品或开启云备份。你向 Codex、Claude Code、WorkBuddy 等外部 Agent 提供的内容，另受所选 Agent 的数据政策约束。'] },
        { title: '账号与客户端连接', paragraphs: ['连接 Lime Cloud 后，河图网站处理账号标识、显示名称、授权范围、应用环境和连接有效期，使用必要的登录 Cookie；Cloud 访问令牌在河图服务端加密保存，不返回浏览器或 Agent。客户端通过验证码建立受限连接，本机保存连接凭据。退出本站会断开使用本次登录的客户端。'] },
        { title: '模型输入与生成结果', paragraphs: ['模型生成由外部 Agent 通过 CLI/MCP 发起固定任务，先确认本次内容外发与费用。平台渠道经河图网站服务端调用 Lime Cloud；自定义渠道向你配置的服务商发送已批准的输入，密钥保存在本机私密存储，不供 Agent 回读。接收方按各自政策处理输入和结果。', '河图网站保存恢复原操作所需的账号关联、任务与输入摘要、模型、费用上限、操作标识和时间，不在调用记录中保存提示词正文。平台图片使用临时结果服务；临时云端可用期不等于本机候选的保留期。收集后的候选保存在本地，是否采用由你决定。'] },
        { title: '会员、支付与运行数据', paragraphs: ['会员、额度、订单及支付由 Lime Cloud 和其支付服务商处理；河图控制台只读当前账号的会员与额度，并跳转至平台管理订阅。河图不收集银行卡资料。托管平台可能处理提供网站所需的连接、安全与性能数据；不要向公开反馈或诊断提交作品正文、密钥或支付资料。'] },
        { title: '保留、撤回与联系', paragraphs: ['账号连接有有效期，失效后需重新连接；退出会立即撤销本次网站会话及关联客户端。模型操作元数据用于回查与避免重复收费，退出不会删除这些记录，也不会删除本机作品。Cloud 账号、商业记录及服务商处理的数据，需通过对应平台提出查询、更正或删除请求。', '河图相关问题可通过项目仓库反馈。请先提交不含个人信息的说明，再协商合适的联系渠道，不要在公开 Issue 中粘贴私密内容。'] },
      ],
    },
    terms: {
      title: '服务条款',
      description: '河图洛书软件许可、作品权利、Agent 协作和可选付费服务的使用说明。',
      sections: [
        { title: '适用范围与软件许可', paragraphs: ['本页适用于河图洛书官网、河图控制台和本地客户端提供的协作功能。河图洛书软件按项目仓库的 Apache-2.0 许可证提供；软件许可、版权声明及免责约定以该许可证原文为准。Lime Cloud、外部 Agent 和模型供应商的服务另适用各自条款。'] },
        { title: '作品与授权', paragraphs: ['你对自己有权使用的作品、设定和素材保留相应权利。使用开源软件不代表作品公开或被授予开源许可。请仅处理你有权使用的内容，并在发送给外部 Agent 或模型服务前核对来源、授权和接收范围。'] },
        { title: 'Agent 协作与作者决定', paragraphs: ['外部 Agent 通过 CLI、MCP 和 Skills 协作。受管入口按任务范围、修订和明确批准执行；候选接收不等于作品采纳或定稿。请审阅生成内容及来源，核对事实、版权和适用性后再决定使用。对你另行授予其他软件的系统文件权限，河图任务授权不能替代操作系统隔离。'] },
        { title: '可选模型服务与费用', paragraphs: ['本地创作不要求订阅平台模型服务。平台模型费用以当前应用、环境、报价和批准上限为准；会员、购买、续费、取消和退款按 Lime Cloud 实际商品及支付规则处理。沙箱测试支付与正式支付分别显示，请在付款前核对支付模式。', '自定义渠道由你选择服务商并提供凭据，实际费用由该服务商核定。结果未知时应沿原操作回查，不应仅因等待或响应丢失重新生成。河图不保证外部服务持续可用、输出正确或符合你的创作判断。'] },
        { title: '安全使用与数据', paragraphs: ['请妥善保管本机目录、账号与密钥，不向无关人员共享访问凭据，不利用服务侵犯他人权利或干扰系统。数据处理方式见隐私政策；备份与本机文件访问由你管理。遇到异常时保留原操作引用，通过项目反馈渠道提供脱敏信息。'] },
      ],
    },
  },
  en: {
    privacy: {
      title: 'Privacy policy',
      description: 'How Hetu Luoshu handles local works, account connections and optional model services.',
      sections: [
        { title: 'Local works and external agents', paragraphs: ['Manuscripts, scripts, story references and candidates stay in the local workspace you choose. Connecting an account does not automatically upload the whole workspace or enable cloud backup. Content you provide to external agents such as Codex, Claude Code or WorkBuddy is also subject to that agent’s data policy.'] },
        { title: 'Accounts and client connections', paragraphs: ['When you connect Lime Cloud, the Hetu website processes your account identifier, display name, authorization scope, application environment and connection expiry, and uses necessary sign-in cookies. Cloud access tokens are encrypted on the Hetu server and are not returned to the browser or agent. The local client stores a restricted connection credential after code verification. Signing out disconnects clients using that website session.'] },
        { title: 'Model inputs and generated results', paragraphs: ['External agents initiate fixed generation tasks through CLI/MCP after approval of the exact content transfer and cost. The platform channel calls Lime Cloud through the Hetu website server. A custom channel sends approved inputs to your configured provider; its key stays in local private storage and is not readable by agents. Recipients process inputs and results under their own policies.', 'For original-operation recovery, the Hetu website stores account associations, task and input digests, the model, cost ceiling, operation identifiers and timestamps. Its operation records do not store prompt text. Platform images use a temporary-result service; cloud availability is separate from retention of local candidates. Collected candidates stay locally, and you decide whether to adopt them.'] },
        { title: 'Membership, payments and operational data', paragraphs: ['Lime Cloud and its payment providers handle memberships, credits, orders and payments. Hetu reads the current account’s membership and credits and links to the platform for subscription management. Hetu does not collect card details. Hosting providers may process connection, security and performance data needed to serve the website. Do not include manuscripts, credentials or payment information in public feedback or diagnostics.'] },
        { title: 'Retention, withdrawal and contact', paragraphs: ['Account connections expire and must then be renewed. Signing out immediately revokes that website session and its associated clients. Model-operation metadata supports recovery and prevents duplicate charges; signing out does not delete it or local works. Requests about Cloud accounts, commercial records or provider-held data must be directed to the relevant platform.', 'For Hetu questions, use the project repository. Begin with a description containing no personal information and arrange a suitable contact channel; do not paste private content into public issues.'] },
      ],
    },
    terms: {
      title: 'Terms of service',
      description: 'Software licensing, content rights, agent collaboration and optional paid services in Hetu Luoshu.',
      sections: [
        { title: 'Scope and software license', paragraphs: ['This page covers the Hetu Luoshu website, console and local collaboration features. The software is provided under the repository’s Apache-2.0 license; its original text governs software permissions, notices and disclaimers. Lime Cloud, external agents and model providers have separate terms.'] },
        { title: 'Content and permissions', paragraphs: ['You retain the applicable rights in works, references and assets you are entitled to use. Using open-source software does not make your content public or license it as open source. Process only content you have permission to use, and check its source, authorization and recipients before sending it to an agent or model service.'] },
        { title: 'Agents and author decisions', paragraphs: ['External agents collaborate through CLI, MCP and Skills. Managed operations enforce task scope, revisions and explicit approval. Receiving a candidate does not adopt or finalize it. Review generated content, sources, facts, rights and suitability before use. Task permissions do not replace operating-system isolation for file access you separately grant to other software.'] },
        { title: 'Optional model services and costs', paragraphs: ['Local creation does not require a platform model subscription. Platform costs depend on the current application, environment, quote and approved ceiling. Membership, purchase, renewal, cancellation and refund rules belong to the actual Lime Cloud product and payment flow. Sandbox test and live payment modes are displayed separately; check the mode before paying.', 'You choose and supply credentials for a custom provider, which determines its actual charges. Recover an unknown result through the original operation instead of generating again because of a delay or lost response. Hetu does not guarantee external service availability, output accuracy or suitability for your creative judgment.'] },
        { title: 'Safe use and data', paragraphs: ['Protect local directories, accounts and keys. Do not share credentials with unrelated parties, infringe others’ rights or disrupt services. The privacy policy explains data handling; you manage backups and local file access. Keep the original operation reference when reporting a problem and share only redacted information through project feedback.'] },
      ],
    },
  },
};
