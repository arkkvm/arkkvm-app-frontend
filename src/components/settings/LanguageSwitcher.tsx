/**
 * @Purpose: Language switcher component
 * @Description: Provides language switching functionality with Zustand state management
 * @version: 1.0.0
 * @Author: zhanglei
 * @Date: 2025-07-17 15:42:00
 * @LastEditors: zhanglei
 * @LastEditTime: 2025-07-21 16:14:53
 */
import { cn } from '@/lib/utils';
import { ReactComponent as LanguageIcon } from '@/assets/icons/Language.svg';
import { useGlobalSettingsStore } from '@/stores';
import { createLogger } from '@/utils/logger';
import React from 'react';
import { useTranslation } from 'react-i18next';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '../ui/select';

const logger = createLogger('LanguageSwitcher');

interface LanguageSwitcherProps {
  className?: string
  bordered?: boolean
  showIcon?: boolean
}

export const LanguageSwitcher: React.FC<LanguageSwitcherProps> = ({
  className,
  bordered = true,
  showIcon = false,
}) => {
  const { currentLang, supportedLanguages, setLanguage } =
    useGlobalSettingsStore();
  const { t, i18n } = useTranslation();
  const [language, setLanguageState] = React.useState(currentLang);

  // Listen to zustand state changes and update component internal state
  React.useEffect(() => {
    if (currentLang && currentLang !== language) {
      logger.info('Language state change detected', { newLang: currentLang });
      setLanguageState(currentLang);
    }
  }, [currentLang]);

  const selectedLang = supportedLanguages.some(lang => lang.code === language)
    ? language
    : supportedLanguages[0]?.code || '';

  const handleLanguageChange = (value: string) => {
    logger.info('Language change requested', { language: value });

    // Update local storage first to ensure persistence
    localStorage.setItem('preferred-language', value);

    // Set Zustand state (only update state, don't call i18n.changeLanguage)
    setLanguage(value);

    // Call i18n to switch language directly
    i18n
      .changeLanguage(value)
      .then(() => {
        logger.info('Language changed successfully', { language: value });
        // Update component internal state
        setLanguageState(value);
        // Force component refresh
        forceUpdate();
      })
      .catch(err => {
        logger.error('Language change failed', err);
      });
  };

  // Create a force update hook
  const [, updateState] = React.useState<object>();
  const forceUpdate = React.useCallback(() => updateState({}), []);

  return (
    <Select
      size="xs"
      value={selectedLang}
      onValueChange={handleLanguageChange}
    >
      <SelectTrigger
        className={cn(
          'w-full',
          !bordered && 'w-auto border-0 shadow-none dark:bg-transparent dark:hover:bg-transparent [&>svg:last-child]:hidden',
          className
        )}
        aria-label={t('selectLanguage')}
      >
        <span className="flex items-center gap-2">
          {showIcon && <LanguageIcon className="size-4" aria-hidden="true" />}
          <SelectValue placeholder={t('selectLanguage')} />
        </span>
      </SelectTrigger>
      <SelectContent>
        {supportedLanguages.map(lang => (
          <SelectItem
            key={lang.code}
            value={lang.code}
            className="cursor-pointer"
          >
            {t(`language.${lang.code}`, { defaultValue: lang.name })}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};
