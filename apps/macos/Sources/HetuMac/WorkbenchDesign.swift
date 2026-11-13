import SwiftUI
import HetuNative

/// 连续的雾色背景只负责装饰，不接收输入或进入辅助功能树。
struct WorkbenchBackdrop: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    var body: some View {
        GeometryReader { geometry in
            let span = max(geometry.size.width, geometry.size.height)
            ZStack {
                LinearGradient(colors: [WorkbenchPalette.canvasStart, WorkbenchPalette.canvasMiddle, WorkbenchPalette.canvasEnd], startPoint: .topLeading, endPoint: .bottomTrailing)
                if contrast != .increased && !reduceTransparency {
                    RadialGradient(colors: [WorkbenchPalette.mistMint.opacity(scheme == .dark ? 0.20 : 0.40), .clear], center: .topLeading, startRadius: 0, endRadius: span * 0.72)
                    RadialGradient(colors: [WorkbenchPalette.mistBlue.opacity(scheme == .dark ? 0.17 : 0.35), .clear], center: .topTrailing, startRadius: 0, endRadius: span * 0.58)
                    RadialGradient(colors: [WorkbenchPalette.mistLilac.opacity(scheme == .dark ? 0.15 : 0.32), .clear], center: .bottomTrailing, startRadius: 0, endRadius: span * 0.66)
                }
            }
        }.accessibilityHidden(true).allowsHitTesting(false)
    }
}

private struct WorkbenchSurface: ViewModifier {
    var radius: CGFloat
    @Environment(\.colorScheme) private var scheme
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    func body(content: Content) -> some View {
        content
            .background(WorkbenchPalette.surface.opacity(reduceTransparency || contrast == .increased ? 1 : scheme == .dark ? 0.92 : 0.84), in: RoundedRectangle(cornerRadius: radius))
            .overlay { RoundedRectangle(cornerRadius: radius).strokeBorder(WorkbenchPalette.line.opacity(contrast == .increased ? 1 : 0.65), lineWidth: 0.5).allowsHitTesting(false) }
            .shadow(color: .black.opacity(scheme == .dark ? 0.08 : 0.025), radius: 14, x: 0, y: 5)
    }
}

extension View {
    func workbenchSurface(radius: CGFloat = 12) -> some View { modifier(WorkbenchSurface(radius: radius)) }
    func workbenchPage() -> some View {
        frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .workbenchSurface(radius: 16).padding(20)
    }
}

struct WorkbenchHeading<Actions: View>: View {
    let title: String
    var subtitle = ""
    let artwork: String
    @ViewBuilder var actions: () -> Actions
    var body: some View {
        HStack(spacing: 20) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .firstTextBaseline, spacing: 16) {
                    Text(title).font(.system(size: 25, weight: .medium, design: .serif)).foregroundStyle(WorkbenchPalette.ink)
                    Spacer(minLength: 8)
                    actions()
                }
                if !subtitle.isEmpty { Text(subtitle).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted).lineSpacing(4).fixedSize(horizontal: false, vertical: true) }
            }
            if !artwork.isEmpty { WorkbenchSpotArtwork(name: artwork).frame(width: 96, height: 96) }
        }.frame(minHeight: artwork.isEmpty ? 66 : 96)
    }
}

struct WorkbenchEmptyState: View {
    let title: String
    var detail = ""
    let artwork: String
    var body: some View {
        VStack(spacing: 14) {
            WorkbenchSpotArtwork(name: artwork).frame(width: 220, height: 152)
            Text(title).font(.system(size: 18, weight: .semibold)).multilineTextAlignment(.center)
            if !detail.isEmpty { Text(detail).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted).lineSpacing(4).multilineTextAlignment(.center).frame(maxWidth: 360) }
        }.padding(24).frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct WorkbenchNavigationStyle: ButtonStyle {
    var selected = false
    @State private var hovered = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(selected ? WorkbenchPalette.jadeSoft : WorkbenchPalette.surface.opacity(hovered || configuration.isPressed ? 0.6 : 0), in: RoundedRectangle(cornerRadius: 9))
            .overlay(alignment: .leading) {
                if selected { Capsule().fill(WorkbenchPalette.jade).frame(width: 3, height: 18).padding(.leading, 1).accessibilityHidden(true) }
            }
            .onHover { hovered = $0 }
    }
}
