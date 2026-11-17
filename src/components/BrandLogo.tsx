import { OFFICIAL_LOGO_SRC } from '../data/brandCatalog';

interface BrandLogoProps {
  className?: string;
  heightClass?: string;
}

export function BrandLogo({ className = '', heightClass = 'h-12' }: BrandLogoProps) {
  return (
    <img
      src={OFFICIAL_LOGO_SRC}
      alt="Celebration Sisters Event Decor"
      referrerPolicy="no-referrer"
      className={`${heightClass} w-auto object-contain select-none ${className}`}
    />
  );
}
