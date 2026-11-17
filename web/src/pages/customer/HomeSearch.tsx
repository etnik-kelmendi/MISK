import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import type { Category } from '../../api/types';
import { Icon } from '../../components/Icon';
import { CATEGORY_COLORS } from './categoryColors';

/** Results start from this many characters, so one letter does not list everything. */
const MIN_QUERY = 2;
const MAX_RESULTS = 8;

interface Result {
  key: string;
  to: string;
  title: string;
  detail: string;
  category: Category;
}

/** Trades and services whose name or description contains every word of the query (D68). */
export function searchCatalogue(categories: Category[], query: string): Result[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (text: string) => words.every((word) => text.toLowerCase().includes(word));
  const results: Result[] = [];
  for (const category of categories) {
    if (matches(category.name)) {
      results.push({ key: `c-${category.id}`, to: `/category/${category.slug}`, title: category.name, detail: '', category });
    }
    for (const service of category.services) {
      if (matches(`${service.name} ${service.description} ${category.name}`)) {
        results.push({
          key: `s-${service.id}`,
          // The service is already ticked on the trade's Services page.
          to: `/category/${category.slug}?service=${encodeURIComponent(service.id)}`,
          title: service.name,
          detail: category.name,
          category,
        });
      }
    }
  }
  return results.slice(0, MAX_RESULTS);
}

/** "What do you need help with?": search the trades and services on the Home page. */
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
            <li className="small muted pad-s">{t('home.searchNone', { query: trimmed })}</li>
          ) : (
            results.map((result) => {
              const color = CATEGORY_COLORS[result.category.icon];
              return (
                <li key={result.key}>
                  <Link to={result.to} className="search-hit">
                    <span className="ci" style={{ background: color.bg, color: color.fg }} aria-hidden="true">
                      <Icon name={result.category.icon} />
                    </span>
                    <span className="grow">
                      <span className="b small block">{result.title}</span>
                      {result.detail && <span className="tiny muted block">{result.detail}</span>}
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
