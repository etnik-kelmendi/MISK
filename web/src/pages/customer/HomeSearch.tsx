import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import type { Category, Service } from '../../api/types';
import { Icon } from '../../components/Icon';
import { euro } from '../../lib/format';
import { CATEGORY_COLORS } from './categoryColors';

/** Results start from this many characters, so one letter does not list everything. */
const MIN_QUERY = 2;
const MAX_RESULTS = 8;

export interface SearchResult {
  key: string;
  to: string;
  service: Service;
  category: Category;
}

/**
 * Services whose name, or whose trade's name, contains every word of the query (D68, D89). The catalogue
 * only holds published trades and visible services, in the order the team set, so results follow it too.
 */
export function searchCatalogue(categories: Category[], query: string): SearchResult[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (text: string) => words.every((word) => text.toLowerCase().includes(word));
  const results: SearchResult[] = [];
  for (const category of categories) {
    for (const service of category.services) {
      if (matches(`${service.name} ${category.name}`)) {
        results.push({
          key: service.id,
          // The service is already ticked on the trade's Services page.
          to: `/category/${category.slug}?service=${encodeURIComponent(service.id)}`,
          service,
          category,
        });
      }
    }
  }
  return results.slice(0, MAX_RESULTS);
}

/** "What do you need help with?": search the services and trades on the Home page. */
export function HomeSearch({ categories }: { categories: Category[] }) {
  const { t } = useTranslation();
  const id = useId();
  const [query, setQuery] = useState('');
  const trimmed = query.trim();
  const results = trimmed.length >= MIN_QUERY ? searchCatalogue(categories, trimmed) : null;

  return (
    <div className="home-search" role="search">
      <label htmlFor={id} className="visually-hidden">
        {t('home.search')}
      </label>
      <span className="search-box">
        <Icon name="search" />
        <input
          id={id}
          type="search"
          autoComplete="off"
          maxLength={60}
          placeholder={t('home.search')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </span>
      {results && (
        <ul className="search-results" aria-label={t('home.searchResults')}>
          {results.length === 0 ? (
            <li className="small muted pad-s" role="status">
              {t('home.searchNone')}
            </li>
          ) : (
            results.map(({ key, to, service, category }) => {
              const color = CATEGORY_COLORS[category.icon];
              return (
                <li key={key}>
                  <Link to={to} className="search-hit">
                    <span className="ci" style={{ background: color.bg, color: color.fg }} aria-hidden="true">
                      <Icon name={category.icon} />
                    </span>
                    <span className="grow">
                      <span className="b small block">{service.name}</span>
                      <span className="tiny muted block">{category.name}</span>
                    </span>
                    <span className="small b brand-text nowrap">
                      {service.pricing === 'hourly'
                        ? t('category.perHour', { price: euro(service.priceCents) })
                        : t('category.from', { price: euro(service.priceCents) })}
                    </span>
                    <Icon name="chevR" />
                  </Link>
                </li>
              );
            })
          )}
        </ul>
      )}
    </div>
  );
}
