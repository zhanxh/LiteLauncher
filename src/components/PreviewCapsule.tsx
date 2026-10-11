import { Component } from 'solid-js';
import { ActionPreviewCapsule } from '@ll/sdk';

interface PreviewCapsuleProps {
  capsule: ActionPreviewCapsule;
  onExecute: () => void;
}

/**
 * 即时动作实时语义预览胶囊组件
 */
export const PreviewCapsule: Component<PreviewCapsuleProps> = (props) => {
  return (
    <div class="preview-capsule-container" onClick={props.onExecute}>
      <div class="capsule-info">
        <div class="capsule-header">
          <span class="capsule-title">{props.capsule.title}</span>
          <span class="capsule-badge">{props.capsule.badge}</span>
        </div>
        <div class="capsule-detail">{props.capsule.detail}</div>
      </div>
      <div class="capsule-action-hint">
        <span>↵</span>
        <span>{props.capsule.hint}</span>
      </div>
    </div>
  );
};
