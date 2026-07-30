import { useEffect, useState, type ImgHTMLAttributes } from 'react';
import { UtensilsCrossed } from 'lucide-react';

type MenuItemImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & {
  src?: string;
};

export function MenuItemImage({ src, alt = '', style, onError, ...props }: MenuItemImageProps) {
  const [failed, setFailed] = useState(!src);

  useEffect(() => {
    setFailed(!src);
  }, [src]);

  if (failed) {
    return (
      <span
        role="img"
        aria-label={alt || 'Món ăn chưa có ảnh'}
        style={{
          ...style,
          display: 'grid',
          placeItems: 'center',
          color: '#94A3B8',
          background: '#F1F5F9',
        }}
      >
        <UtensilsCrossed size={22} aria-hidden="true" />
      </span>
    );
  }

  return (
    <img
      {...props}
      src={src}
      alt={alt}
      style={style}
      onError={event => {
        onError?.(event);
        setFailed(true);
      }}
    />
  );
}
