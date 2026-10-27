import { IconK, IconLogo, IconM, IconR, IconV } from '@/assets/icons';
import { cn } from '@/lib/utils';
import React from 'react';

export type BrandLogoProps = {
  /** Render only the icon or the full wordmark */
  type?: 'icon' | 'full'
  /** Force light/dark colors, or detect from document root class */
  variant?: 'auto' | 'light' | 'dark'
  /** Height in pixels; width scales proportionally */
  size?: number
  /** Override main monochrome color (for text and main icon shape) */
  primaryColor?: string
  /** Accent color of the small triangle */
  accentColor?: string
  className?: string
  style?: React.CSSProperties
}

/**
 * BrandLogo
 * - Supports icon-only or full logo (icon + wordmark)
 * - Uses the surrounding theme's text color, including locally themed pages.
 */
export const BrandLogo: React.FC<BrandLogoProps> = ({
  type = 'full',
  size = 28,
  primaryColor,
  className,
  style,
}) => {
  const mainColor = primaryColor ?? 'var(--text-color)';
  const letterPx = Math.max(12, Math.round(size));
  const iconPx = size + 6;

  const iconStyle: React.CSSProperties = { width: iconPx, height: iconPx, flexShrink: 0 };
  const letterStyle: React.CSSProperties = { width: letterPx, height: letterPx, flexShrink: 0 };

  if (type === 'icon') {
    return <IconLogo className={cn('brand-logo-icon', className)} style={{ ...iconStyle, color: mainColor, ...style }} />;
  }

  return (
    <div
      className={cn('flex items-center justify-center gap-[2px] brand-logo-container', className)}
      style={{
        '--logo-color': mainColor,
        '--logo-size': size,
        '--icon-size': iconPx,
        ...style,
      } as React.CSSProperties}
    >
      <IconLogo
        className="brand-logo-icon"
        style={iconStyle}
      />

      <IconR
        className="brand-logo-letter"
        style={letterStyle}
      />
      <IconK
        className="brand-logo-letter"
        style={letterStyle}
      />
      <IconK
        className="brand-logo-letter"
        style={letterStyle}
      />

      <IconV
        className="brand-logo-letter"
        style={letterStyle}
      />
      <IconM
        className="brand-logo-letter"
        style={letterStyle}
      />
    </div>
  );
};

export default BrandLogo;
