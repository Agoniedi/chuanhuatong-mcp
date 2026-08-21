interface Props {
  name: string;
  resourceId: string | null;
  isAgent?: boolean;
  size?: 'small' | 'medium' | 'large';
}

// 稳定散列：同一名字总是同一色调（0-5），与 CSS 中的 data-tone 变量对应
function toneFor(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 6;
}

export default function Avatar({
  name,
  resourceId,
  isAgent = false,
  size = 'medium',
}: Props) {
  const className = `avatar avatar-${size} ${isAgent ? 'avatar-agent' : 'avatar-human'}`;
  if (resourceId) {
    return (
      <img
        className={className}
        src={`/v1/profile-resources/${encodeURIComponent(resourceId)}`}
        alt=""
      />
    );
  }
  return (
    <span
      className={className}
      data-tone={isAgent ? undefined : toneFor(name)}
      aria-hidden="true"
    >
      {isAgent ? 'AI' : name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  );
}
