/**
 * @Purpose:
 * @Descripttion:
 * @version:
 * @Author: zhanglei
 * @Date: 2026-01-29 19:26:36
 * @LastEditors: zhanglei
 * @LastEditTime: 2026-01-29 19:40:03
 */
import { useTranslation } from 'react-i18next';

interface TipListProps {
  titleKey?: string
  itemsKey?: string | string[]
  numbered?: boolean
  className?: string
}

export const TipList = ({
  titleKey,
  itemsKey,
  numbered = true,
  className = '',
}: TipListProps) => {
  const { t } = useTranslation();

  const listItems = Array.isArray(itemsKey)
    ? itemsKey
    : itemsKey
      ? t(itemsKey, { returnObjects: true })
      : [];

  return (
    <div className={`text-sm ${className}`}>
      <ul>
        <li className="mb-[10px]">{t(titleKey)||'Tips:'}</li>
        {listItems.map((item: string, index: number) => (
          <li key={index} className={index === 0  ? 'mb-[6px]' : ''}>
            <span>{numbered ? `${index + 1}.` : ''}</span>
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
};
