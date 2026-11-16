import React from 'react';
import { Icon } from './workbench.tsx';

export function AuditStatus({ state, message, onReview, onRetry }: {
    state: string;
    message?: string;
    onReview?: () => void;
    onRetry?: () => void;
}) {
    if (state === 'idle') return null;

    return (
        <div className={`audit-status audit-${state}`}>
            <div className="audit-header">
                <Icon name={state === 'failed' ? 'close' : 'sparkles'} />
                <span>{state === 'running' ? '正在处理…' : state === 'waiting_for_audit' ? '有成果可审阅' : '任务执行失败'}</span>
            </div>
            {message && <p className="audit-message">{message}</p>}
            <div className="audit-actions">
                {state === 'waiting_for_audit' && onReview && (
                    <button className="primary" onClick={onReview}>立即审核</button>
                )}
                {state === 'failed' && onRetry && (
                    <button onClick={onRetry}>重试任务</button>
                )}
            </div>
        </div>
    );
}
