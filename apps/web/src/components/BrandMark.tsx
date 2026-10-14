import type {Brand} from '@plunk/shared';

interface BrandMarkProps {
  brand: Brand;
  size?: 'sm' | 'md';
}

export function BrandMark({brand, size = 'md'}: BrandMarkProps) {
  const logoSize = size === 'md' ? 28 : 24;
  // Longer names ("Metacognitive Therapy") wrap onto two smaller lines instead of truncating.
  const long = brand.name.length > 14;
  const textClass = long
    ? `leading-tight line-clamp-2 ${size === 'md' ? 'text-base' : 'text-sm'}`
    : `truncate ${size === 'md' ? 'text-xl' : 'text-lg'}`;

  return (
    <div className="flex items-center gap-2 min-w-0">
      {brand.logoUrl && (
        // eslint-disable-next-line @next/next/no-img-element -- logo hosts (S3, pasted URLs) are unknown at build time
        <img
          src={brand.logoUrl}
          alt=""
          aria-hidden
          width={logoSize}
          height={logoSize}
          className="rounded object-contain shrink-0"
        />
      )}
      <span
        className={`font-bold text-neutral-900 ${textClass}`}
        title={brand.name}
      >
        {brand.name}
      </span>
    </div>
  );
}
