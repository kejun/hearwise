// The display spelling never replaces the identity used by model snapshots.
export const knowledgeName = item => item?.display_name || item?.canonical_name || '未命名知识';
