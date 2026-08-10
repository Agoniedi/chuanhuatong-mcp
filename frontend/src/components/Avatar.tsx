interface Props {
  name: string;
  resourceId: string | null;
  isAgent?: boolean;
  size?: 'small' | 'medium' | 'large';
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
    <span className={className} aria-hidden="true">
      {isAgent ? 'AI' : name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  );
}
