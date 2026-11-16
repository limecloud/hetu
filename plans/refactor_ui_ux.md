# Plan: Refactor for UI/UX & Trust-Enabled Media

## Objective
Revamp the UI/UX for Model Service and Agent interaction, focusing on a transparent trust/approval model (cost, policy validation) and seamless media integration (including Video).

## Key UI/UX Focus Areas
- **Approval Flow:** Modern, clear UI components for cost estimation, content validation, and explicit user approval for tasks.
- **Media Experience:** Unified interface for selecting and configuring Text, Image, and Video models.
- **Trust Indicators:** Clear visual cues indicating budget usage, security policy status, and model connection health.

## Implementation Steps

### 1. Backend Support for UX
- Extend existing JSON-RPC/API contract to provide cost estimation and policy validation data prior to task execution.
- Maintain generic media support to power the new UI.

### 2. UI/UX Refactoring (`apps/task-view/` & `apps/desktop/`)
- **Approval Components:** Develop `ApprovalModal` or `InlineApproval` components that display cost, estimated runtime, and provide a clear "Approve/Reject" interface.
- **Model Selection Revamp:** Create a unified `ModelConfigurator` that adapts to media kind (Text/Image/Video) and provides clear configuration options.
- **Status & Trust Bar:** Update the UI to show active budget and policy status for current Agent sessions.

### 3. Integrated Flow
- Implement the "Pre-flight Check" flow: UI queries backend for approval details -> UI shows approval component -> Backend proceeds with task execution once approved.

## Verification & Testing
- **Visual Testing:** Verify UI components (Approval, Configurator) match the design system.
- **End-to-End Flow:** Ensure that the approval UI correctly blocks and executes based on user decisions.
- **Responsiveness:** Ensure UI remains consistent across different media types and task complexities.

## Deliverables
- Re-designed approval and configuration UI components.
- Updated backend API for approval/cost feedback.
- Seamless flow for Text, Image, and Video tasks.
