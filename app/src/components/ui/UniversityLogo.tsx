import React, { useMemo, useState } from 'react';
import { clsx } from 'clsx';
import { useBranding } from '../../context/BrandingContext';

export type UniversityLogoSize = 'sm' | 'md' | 'lg' | 'xl';

const SIZES: Record<UniversityLogoSize, number> = {
  sm: 32,
  md: 48,
  lg: 72,
  xl: 96,
};

export type UniversityLogoProps = {
  size?: UniversityLogoSize | number;
  className?: string;
  showName?: boolean;
  nameClassName?: string;
  nameVariant?: 'brand' | 'subtle';
  alt?: string;
  onClick?: () => void;
};

const FallbackBUoT: React.FC<{ sizePx: number; className?: string }> = ({ sizePx, className }) => (
  <svg
    width={sizePx}
    height={sizePx}
    viewBox="0 0 56 56"
    xmlns="http://www.w3.org/2000/svg"
    role="img"
    aria-label="Bells University of Technology crest"
    className={clsx('shrink-0 rounded-full ring-2 ring-white shadow-sm', className)}
  >
    <circle cx="28" cy="28" r="28" fill="#0e74cc" />
    <circle cx="28" cy="28" r="24.5" fill="none" stroke="#ffffff" strokeWidth="1.5" opacity="0.25" />
    <text
      x="50%"
      y="55%"
      textAnchor="middle"
      dominantBaseline="middle"
      fill="#ffffff"
      fontWeight="800"
      fontSize="18"
      letterSpacing="0.8"
      fontFamily="'Inter', system-ui, sans-serif"
    >
      BUoT
    </text>
  </svg>
);

export const UniversityLogo: React.FC<UniversityLogoProps> = ({
  size = 'md',
  className,
  showName = false,
  nameClassName,
  nameVariant = 'brand',
  alt,
  onClick,
}) => {
  const { brand } = useBranding();
  const [errored, setErrored] = useState(false);

  const sizePx = typeof size === 'number' ? size : SIZES[size];
  const envLogoUrl = (import.meta.env.VITE_UNIVERSITY_LOGO_URL as string | undefined) || '';
  const brandLogoUrl = brand?.logoUrl || envLogoUrl || '/branding/logo.png';

  const src = useMemo(() => {
    if (errored) return null;
    if (brandLogoUrl && brandLogoUrl.trim().length) return brandLogoUrl;
    return null;
  }, [brandLogoUrl, errored]);

  const altText =
    alt ??
    (brand?.name?.trim().length
      ? `${brand.name.trim()} logo`
      : 'Bells University of Technology logo');

  const content = (
    <div
      className={clsx(
        'inline-flex items-center gap-3 select-none',
        onClick ? 'cursor-pointer' : '',
        className,
      )}
      onClick={onClick}
    >
      {src ? (
        <img
          src={src}
          alt={altText}
          width={sizePx}
          height={sizePx}
          loading="lazy"
          decoding="async"
          onError={() => setErrored(true)}
          className={clsx(
            'shrink-0 rounded-full ring-2 ring-white shadow-sm object-cover bg-white',
            `w-[${sizePx}px] h-[${sizePx}px]`,
          )}
          style={{ width: sizePx, height: sizePx }}
          aria-label={altText}
        />
      ) : (
        <FallbackBUoT sizePx={sizePx} />
      )}
      {showName && (
        <div className="flex flex-col justify-center leading-tight min-w-0">
          <span
            className={clsx(
              'font-extrabold tracking-tight truncate',
              sizePx < 40 ? 'text-sm' : sizePx < 72 ? 'text-base sm:text-lg' : 'text-lg sm:text-xl',
              nameVariant === 'brand' ? 'text-[var(--brand-primary,#0e74cc)]' : 'text-gray-900',
              nameClassName,
            )}
          >
            {brand?.name?.trim() ||
              (import.meta.env.VITE_UNIVERSITY_NAME as string | undefined) ||
              'Bells University of Technology'}
          </span>
          <span className="text-[11px] text-gray-500 mt-0.5 truncate">
            Bursary Payment Portal
          </span>
        </div>
      )}
    </div>
  );

  return content;
};

UniversityLogo.displayName = 'UniversityLogo';

export default UniversityLogo;
