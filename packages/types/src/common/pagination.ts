/**
 * Generic pagination types for the Plunk platform
 */

/**
 * Offset-based pagination response
 * Used for: Templates, Workflows, and other paginated lists with fixed page sizes
 *
 * @template T - The type of items in the paginated response
 */
export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/**
 * Cursor-based pagination response
 * Used for: Contacts, Activities, and other large datasets requiring efficient pagination
 *
 * Cursor pagination is more efficient for large datasets (1M+ rows) as it doesn't
 * require offset calculations and provides stable pagination when data changes.
 *
 * @template T - The type of items in the paginated response
 */
export interface CursorPaginatedResponse<T> {
  data: T[];
  cursor?: string;
  hasMore: boolean;
  total?: number; // Optional: computed on first page only for performance
  // Contact-list only, computed on first page only for performance (see ContactService.list):
  // `total` split into mailable contacts (email present, subscribed, not deleted) and leads
  // (no email). Lets the dashboard headline show "correct-and-filtered" rather than "wrong".
  mailable?: number;
  leads?: number;
}
