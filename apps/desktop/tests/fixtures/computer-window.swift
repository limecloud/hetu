import AppKit

// 隔离窗口不激活应用，不读取用户内容；仅用于原生观察及后台AX设值。
let application=NSApplication.shared
application.setActivationPolicy(.accessory)
application.finishLaunching()
let window=NSWindow(contentRect:NSRect(x:-3000,y:-3000,width:480,height:240),styleMask:[.titled,.closable],backing:.buffered,defer:false)
window.title="HETU-COMPUTER-FIXTURE"
let field=NSTextField(frame:NSRect(x:24,y:120,width:400,height:28))
field.stringValue="SAFE-COMPUTER-FIXTURE"
field.setAccessibilityIdentifier("hetu-fixture-input")
window.contentView?.addSubview(field)
window.orderFront(nil)
if CommandLine.arguments.contains("--screenshot-only") { application.setAccessibilityWindows([]) }
// 窗口登记与辅助功能响应由主循环完成；进程启动不作为窗口就绪。
DispatchQueue.main.async {
    print("READY \(ProcessInfo.processInfo.processIdentifier)")
    fflush(stdout)
}
application.run()
