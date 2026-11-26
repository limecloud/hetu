/** 插件目录与固定成果选择共用安装状态文案，不以读取成果推断可执行性。 */
export const pluginStateLabels:Readonly<Record<string,string>>={
 active:"已启用",disabled:"已停用",blocked:"依赖未就绪",installed:"已安装",uninstalled:"已卸载",unavailable:"插件包不可用",failed:"清理失败",
};
