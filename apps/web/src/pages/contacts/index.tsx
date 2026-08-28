import {
  Badge,
  Button,
  Card,
  CardContent,
  Checkbox,
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  IconSpinner,
  Input,
  Label,
  Switch,
} from '@plunk/ui';
import type {Contact, Tag} from '@plunk/db';
import {ContactSchemas, SequenceSchemas, TagSchemas} from '@plunk/shared';
import type {CursorPaginatedResponse} from '@plunk/types';
import {
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type OnChangeFn,
  type SortingState,
  type VisibilityState,
} from '@tanstack/react-table';
import {DashboardLayout} from '../../components/DashboardLayout';
import {
  BulkActionBar,
  DataTable,
  DataTableColumnHeader,
  DataTableFacetedFilter,
  DataTableFilter,
  DataTableViewOptions,
  DataTableViewSwitcher,
  NoResultsState,
  isDataTableView,
  type DataTableColumnMeta,
  type DataTableView,
  type FacetedFilterOption,
} from '../../components/data-table';
import {KeyValueEditor} from '../../components/KeyValueEditor';
import {network} from '../../lib/network';
import {formatRelativeTime} from '../../lib/dateUtils';
import {useColumnVisibility} from '../../lib/hooks/useColumnVisibility';
import {usePersistentState} from '../../lib/hooks/usePersistentState';
import {
  AlertTriangle,
  Check,
  CheckCircle,
  ChevronLeft,
  ChevronRight,
  Edit,
  FileUp,
  ListOrdered,
  Loader2,
  Mail,
  MailCheck,
  MailX,
  Minus,
  Plus,
  Search,
  Tag as TagIcon,
  Trash2,
  Upload,
  UserPlus,
  X,
  XCircle,
} from 'lucide-react';
import {NextSeo} from 'next-seo';
import Link from 'next/link';
import {useRouter} from 'next/router';
import {useEffect, useMemo, useRef, useState} from 'react';
import {toast} from 'sonner';
import useSWR from 'swr';
import dayjs from 'dayjs';

type StatusFilter = 'ALL' | 'subscribed' | 'unsubscribed';
type ContactWithTags = Contact & {tags: {id: string; name: string}[]};

const VIEW_STORAGE_KEY = 'plunk:contacts:view';
const COLUMNS_STORAGE_KEY = 'plunk:contacts:columns';

// Fixed-value options for the Status faceted filter (table header) and the
// card-view toolbar dropdown. Single source of truth for both.
const STATUS_OPTIONS: FacetedFilterOption[] = [
  {value: 'subscribed', label: 'Subscribed'},
  {value: 'unsubscribed', label: 'Unsubscribed'},
];

// select + email + actions are locked-visible (see lockedColumnIds). `updatedAt`
// starts hidden so the Columns menu has a meaningful toggle out of the box.
const DEFAULT_COLUMN_VISIBILITY: VisibilityState = {
  select: true,
  email: true,
  status: true,
  tags: true,
  externalId: false,
  createdAt: true,
  updatedAt: false,
  actions: true,
};

export default function ContactsPage() {
  const router = useRouter();
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [cursorHistory, setCursorHistory] = useState<(string | undefined)[]>([undefined]);
  const [currentPage, setCurrentPage] = useState(0);
  const [contacts, setContacts] = useState<ContactWithTags[]>([]);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');
  const [tagsFilter, setTagsFilter] = useState<string[]>([]);
  const {data: allTags} = useSWR<Tag[]>('/tags', {revalidateOnFocus: false});
  const tagFacetOptions: FacetedFilterOption[] = useMemo(
    () => (allTags ?? []).map(tag => ({value: tag.id, label: tag.name})),
    [allTags],
  );
  const [view, setView] = usePersistentState<DataTableView>(VIEW_STORAGE_KEY, 'table', isDataTableView);
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnVisibility, setColumnVisibility] = useColumnVisibility(COLUMNS_STORAGE_KEY, DEFAULT_COLUMN_VISIBILITY);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [contactToDelete, setContactToDelete] = useState<string | null>(null);
  const [totalCount, setTotalCount] = useState<number>(0);
  const [selectedContacts, setSelectedContacts] = useState<Set<string>>(new Set());
  const [selectAllMatching, setSelectAllMatching] = useState(false);
  const [excludedContacts, setExcludedContacts] = useState<Set<string>>(new Set());
  const [showBulkActionsDialog, setShowBulkActionsDialog] = useState(false);
  const [bulkOperation, setBulkOperation] = useState<'subscribe' | 'unsubscribe' | 'delete' | null>(null);
  const [showTagBulkDialog, setShowTagBulkDialog] = useState(false);
  const [tagBulkAction, setTagBulkAction] = useState<'add' | 'remove' | null>(null);
  const [showSequenceBulkDialog, setShowSequenceBulkDialog] = useState(false);
  const pageSize = 50;

  // Seed the tag facet from a `?tags=<tagId>` link (e.g. from the Tags index
  // page's "view contacts" links). Runs once the router query is ready.
  const tagsQueryHydrated = useRef(false);
  useEffect(() => {
    if (!router.isReady || tagsQueryHydrated.current) return;
    tagsQueryHydrated.current = true;
    const raw = router.query.tags;
    const fromQuery = typeof raw === 'string' ? raw.split(',').filter(Boolean) : Array.isArray(raw) ? raw : [];
    if (fromQuery.length > 0) {
      setTagsFilter(fromQuery);
    }
  }, [router.isReady, router.query.tags]);

  // Backend is authoritative for sorting + status/tag filtering
  // (?sort=&dir=, ?subscribed=, ?tags=); the client only mirrors the active state.
  const sortParam = sorting[0]?.id ?? '';
  const dirParam = sorting[0] ? (sorting[0].desc ? 'desc' : 'asc') : '';
  const subscribedParam = statusFilter === 'subscribed' ? 'true' : statusFilter === 'unsubscribed' ? 'false' : '';
  const tagsParam = tagsFilter.join(',');

  const {data, mutate, isLoading} = useSWR<CursorPaginatedResponse<ContactWithTags>>(
    `/contacts?limit=${pageSize}${cursor ? `&cursor=${cursor}` : ''}${
      search ? `&search=${encodeURIComponent(search)}` : ''
    }${subscribedParam ? `&subscribed=${subscribedParam}` : ''}${
      tagsParam ? `&tags=${encodeURIComponent(tagsParam)}` : ''
    }${sortParam ? `&sort=${sortParam}&dir=${dirParam}` : ''}`,
    {revalidateOnFocus: false},
  );

  useEffect(() => {
    if (data) {
      setContacts(data.data);
      if (!cursor) {
        setTotalCount(data.total || data.data.length);
      }
    }
  }, [data, cursor]);

  // Reset the cursor stack — used whenever the query (search/status) or the
  // ordering changes, since cursors are tied to a specific filter + sort.
  const resetPagination = () => {
    setCursor(undefined);
    setCursorHistory([undefined]);
    setCurrentPage(0);
    setContacts([]);
  };

  const clearSelection = () => {
    setSelectedContacts(new Set());
    setSelectAllMatching(false);
    setExcludedContacts(new Set());
  };

  const handleStatusChange = (next: StatusFilter) => {
    setStatusFilter(next);
    resetPagination();
    clearSelection();
  };

  const handleTagsFilterChange = (next: string[]) => {
    setTagsFilter(next);
    resetPagination();
    clearSelection();
  };

  // Sorting only reorders the same matching set, so selection survives; but the
  // cursor stack is tied to the old ordering and must restart from the first page.
  const handleSortingChange: OnChangeFn<SortingState> = updater => {
    setSorting(prev => (typeof updater === 'function' ? updater(prev) : updater));
    resetPagination();
  };

  // Debounced search. Changing the query resets pagination and selection (the
  // matching set changed, so per-id selections no longer make sense).
  useEffect(() => {
    if (searchInput === search) return;
    const timer = setTimeout(() => {
      setSearch(searchInput);
      resetPagination();
      clearSelection();
    }, 350);
    return () => clearTimeout(timer);
  }, [searchInput, search]);

  const handleNextPage = () => {
    if (data?.cursor) {
      const newPage = currentPage + 1;
      setCursor(data.cursor);
      setCurrentPage(newPage);
      // Preserve selection across pages only when "select all matching" is on; otherwise
      // clear, since per-page id sets stop being meaningful once you've left the page.
      if (!selectAllMatching) {
        setSelectedContacts(new Set());
      }

      if (cursorHistory.length <= newPage) {
        setCursorHistory(prev => [...prev, data.cursor]);
      }
    }
  };

  const handlePreviousPage = () => {
    if (currentPage > 0) {
      const newPage = currentPage - 1;
      const previousCursor = cursorHistory[newPage];
      setCursor(previousCursor);
      setCurrentPage(newPage);
      if (!selectAllMatching) {
        setSelectedContacts(new Set());
      }
    }
  };

  // True when the current page's checkbox should appear "all selected"
  const allOnPageSelected = contacts.length > 0 && (
    selectAllMatching
      ? contacts.every(c => !excludedContacts.has(c.id))
      : selectedContacts.size === contacts.length && contacts.every(c => selectedContacts.has(c.id))
  );

  const handleSelectAll = () => {
    if (selectAllMatching) {
      // Toggle: exclude or re-include all on this page
      if (allOnPageSelected) {
        setExcludedContacts(prev => {
          const next = new Set(prev);
          contacts.forEach(c => next.add(c.id));
          return next;
        });
      } else {
        setExcludedContacts(prev => {
          const next = new Set(prev);
          contacts.forEach(c => next.delete(c.id));
          return next;
        });
      }
      return;
    }
    if (allOnPageSelected) {
      setSelectedContacts(new Set());
    } else {
      setSelectedContacts(new Set(contacts.map(c => c.id)));
    }
  };

  const handleSelectContact = (contactId: string) => {
    if (selectAllMatching) {
      setExcludedContacts(prev => {
        const next = new Set(prev);
        if (next.has(contactId)) next.delete(contactId);
        else next.add(contactId);
        return next;
      });
      return;
    }
    setSelectedContacts(prev => {
      const next = new Set(prev);
      if (next.has(contactId)) next.delete(contactId);
      else next.add(contactId);
      return next;
    });
  };

  // Function declaration (hoisted) so the column defs and derived values above
  // can reference it regardless of source order.
  function isContactSelected(contactId: string) {
    return selectAllMatching ? !excludedContacts.has(contactId) : selectedContacts.has(contactId);
  }

  const effectiveSelectionCount = selectAllMatching
    ? Math.max(0, totalCount - excludedContacts.size)
    : selectedContacts.size;

  const handleBulkAction = (operation: 'subscribe' | 'unsubscribe' | 'delete') => {
    setBulkOperation(operation);
    setShowBulkActionsDialog(true);
  };

  const handleTagBulkAction = (action: 'add' | 'remove') => {
    setTagBulkAction(action);
    setShowTagBulkDialog(true);
  };

  const handleSelectAllMatching = () => {
    setSelectAllMatching(true);
    setSelectedContacts(new Set());
    setExcludedContacts(new Set());
  };

  const promptDelete = (contactId: string) => {
    setContactToDelete(contactId);
    setShowDeleteDialog(true);
  };

  const handleDelete = async () => {
    if (!contactToDelete) return;

    try {
      await network.fetch('DELETE', `/contacts/${contactToDelete}`);
      toast.success('Contact deleted');
      void mutate();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Couldn’t delete the contact. Try again.');
    } finally {
      setContactToDelete(null);
    }
  };

  const hasData = contacts.length > 0;

  // Whether any search/status filter is narrowing the list — drives the
  // "no results vs first-run empty" distinction below.
  const hasActiveFilters = search !== '' || statusFilter !== 'ALL' || tagsFilter.length > 0;

  // Reset everything that can hide rows (search + status + tags + pagination)
  // so the user can recover from a filter combination that matched nothing.
  const clearFilters = () => {
    setSearchInput('');
    setSearch('');
    setStatusFilter('ALL');
    setTagsFilter([]);
    resetPagination();
    clearSelection();
  };

  const columns = useMemo<Array<ColumnDef<ContactWithTags, unknown>>>(
    () => [
      {
        id: 'select',
        enableSorting: false,
        enableHiding: false, // Selection column is locked-visible.
        meta: {label: 'Select', headClassName: 'w-10', cellClassName: 'w-10'} satisfies DataTableColumnMeta,
        header: () => (
          <Checkbox
            aria-label="Select all contacts on this page"
            checked={allOnPageSelected ? true : contacts.some(c => isContactSelected(c.id)) ? 'indeterminate' : false}
            onCheckedChange={handleSelectAll}
          />
        ),
        cell: ({row}) => (
          <Checkbox
            aria-label={`Select ${row.original.email ?? 'lead (no email)'}`}
            checked={isContactSelected(row.original.id)}
            onClick={e => e.stopPropagation()}
            onCheckedChange={() => handleSelectContact(row.original.id)}
          />
        ),
      },
      {
        id: 'email',
        accessorKey: 'email',
        enableHiding: false, // Email column is locked-visible.
        meta: {label: 'Email'} satisfies DataTableColumnMeta,
        header: ({column}) => <DataTableColumnHeader column={column}>Email</DataTableColumnHeader>,
        cell: ({row}) => (
          <div className="flex items-center gap-2">
            {!row.original.email ? (
              <UserPlus className="h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
            ) : row.original.subscribed ? (
              <MailCheck className="h-4 w-4 shrink-0 text-green-600" aria-hidden="true" />
            ) : (
              <MailX className="h-4 w-4 shrink-0 text-red-600" aria-hidden="true" />
            )}
            <Link
              href={`/contacts/${row.original.id}`}
              className="text-sm font-medium text-neutral-900 hover:text-neutral-700 focus-visible:outline-none focus-visible:underline"
            >
              {/* A lead has no email -- it can't be mailed (see contact-filters.ts), so it's
                  marked distinctly rather than shown as a blank/broken row. */}
              {row.original.email ?? <span className="italic text-neutral-500">Lead (no email)</span>}
            </Link>
          </div>
        ),
      },
      {
        id: 'status',
        accessorKey: 'subscribed',
        enableSorting: false, // Status is faceted-filtered, not sorted.
        meta: {label: 'Status'} satisfies DataTableColumnMeta,
        header: ({column}) => (
          <DataTableColumnHeader
            column={column}
            filter={
              <DataTableFacetedFilter
                title="Status"
                multiple={false}
                options={STATUS_OPTIONS}
                selected={statusFilter === 'ALL' ? [] : [statusFilter]}
                onChange={next => handleStatusChange((next[0] as StatusFilter) ?? 'ALL')}
              />
            }
          >
            Status
          </DataTableColumnHeader>
        ),
        cell: ({row}) =>
          !row.original.email ? (
            <Badge variant="warning">Lead</Badge>
          ) : (
            <Badge variant={row.original.subscribed ? 'success' : 'destructive'}>
              {row.original.subscribed ? 'Subscribed' : 'Unsubscribed'}
            </Badge>
          ),
      },
      {
        id: 'tags',
        enableSorting: false, // Tags are faceted-filtered, not sorted.
        meta: {label: 'Tags'} satisfies DataTableColumnMeta,
        header: ({column}) => (
          <DataTableColumnHeader
            column={column}
            filter={
              <DataTableFacetedFilter
                title="Tags"
                options={tagFacetOptions}
                selected={tagsFilter}
                onChange={handleTagsFilterChange}
              />
            }
          >
            Tags
          </DataTableColumnHeader>
        ),
        cell: ({row}) => <ContactTagsCell tags={row.original.tags} />,
      },
      {
        id: 'externalId',
        accessorKey: 'externalId',
        enableSorting: false, // Not backed by a sortable index for this list.
        meta: {label: 'External ID'} satisfies DataTableColumnMeta,
        header: ({column}) => <DataTableColumnHeader column={column}>External ID</DataTableColumnHeader>,
        cell: ({row}) =>
          row.original.externalId ? (
            <span className="text-xs font-mono text-neutral-500 break-all">{row.original.externalId}</span>
          ) : (
            <span className="text-xs text-neutral-400">—</span>
          ),
      },
      {
        id: 'createdAt',
        accessorKey: 'createdAt',
        sortDescFirst: true, // First click surfaces the newest contacts.
        meta: {label: 'Created'} satisfies DataTableColumnMeta,
        header: ({column}) => <DataTableColumnHeader column={column}>Created</DataTableColumnHeader>,
        cell: ({row}) => (
          <div className="group relative inline-block cursor-help text-sm text-neutral-500 whitespace-nowrap">
            {formatRelativeTime(row.original.createdAt)}
            <div className="hidden group-hover:block absolute z-10 w-48 p-2 bg-neutral-900 text-white text-xs rounded shadow-md bottom-full left-1/2 transform -translate-x-1/2 mb-1 whitespace-nowrap">
              {dayjs(row.original.createdAt).format('DD MMMM YYYY, hh:mm')}
            </div>
          </div>
        ),
      },
      {
        id: 'updatedAt',
        accessorKey: 'updatedAt',
        enableSorting: false, // No backend sort field for updatedAt.
        meta: {label: 'Updated'} satisfies DataTableColumnMeta,
        header: ({column}) => <DataTableColumnHeader column={column}>Updated</DataTableColumnHeader>,
        cell: ({row}) => (
          <span className="text-sm text-neutral-500 whitespace-nowrap">
            {formatRelativeTime(row.original.updatedAt)}
          </span>
        ),
      },
      {
        id: 'actions',
        enableSorting: false,
        enableHiding: false, // Actions column is locked-visible.
        meta: {label: 'Actions', headClassName: 'text-right', cellClassName: 'text-right'} satisfies DataTableColumnMeta,
        header: () => <span className="flex justify-end">Actions</span>,
        cell: ({row}) => (
          <div className="flex items-center justify-end gap-1">
            <Button asChild variant="ghost" size="sm" title="Edit contact">
              <Link href={`/contacts/${row.original.id}`} aria-label="Edit contact">
                <Edit className="h-4 w-4" />
              </Link>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              title="Delete contact"
              aria-label="Delete contact"
              onClick={() => promptDelete(row.original.id)}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ),
      },
    ],
    // Re-create columns when the facet selection or selection model changes so
    // the select-column checkboxes and the Status/Tags facets read fresh state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      statusFilter,
      tagsFilter,
      tagFacetOptions,
      selectAllMatching,
      selectedContacts,
      excludedContacts,
      contacts,
      allOnPageSelected,
    ],
  );

  const table = useReactTable<ContactWithTags>({
    data: contacts,
    columns,
    state: {sorting, columnVisibility},
    onSortingChange: handleSortingChange,
    onColumnVisibilityChange: setColumnVisibility,
    enableRowSelection: false, // Contacts owns a custom select-all-matching model.
    enableMultiSort: false,
    manualSorting: true, // Backend handles sorting; client just exposes ?sort=&dir=.
    getCoreRowModel: getCoreRowModel(),
    getRowId: row => row.id,
  });

  return (
    <>
      <NextSeo title="Contacts" />
      <DashboardLayout>
        <div className="space-y-6">
          {/* Header */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div className="flex-1 min-w-0">
              <h1 className="text-2xl sm:text-3xl font-bold text-neutral-900">Contacts</h1>
              <p className="text-neutral-500 mt-2 text-sm sm:text-base">
                Everyone you can send to.{' '}
                {totalCount > 0 ? `${totalCount.toLocaleString()} ${hasActiveFilters ? 'matching' : 'total'}` : ''}
              </p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setShowImportDialog(true)} className="flex-1 sm:flex-none">
                <Upload className="h-4 w-4" />
                <span className="hidden sm:inline">Import CSV</span>
                <span className="sm:hidden">Import</span>
              </Button>
              <Button onClick={() => setShowCreateDialog(true)} className="flex-1 sm:flex-none">
                <Plus className="h-4 w-4" />
                <span className="hidden sm:inline">Add contact</span>
                <span className="sm:hidden">Add</span>
              </Button>
            </div>
          </div>

          {/* Control row. One aligned cluster of 32px-tall controls:
              - Search input: always present (both views).
              - Status filter: CARD VIEW ONLY, as a toolbar dropdown matching the
                Columns selector. In table view the Status filter lives in the
                column header facet instead (same shared menu body).
              - Columns selector: TABLE VIEW ONLY.
              - A hairline divider separates the data controls from the view switcher. */}
          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-neutral-400" />
              <Input
                type="text"
                placeholder="Search by email or external ID…"
                value={searchInput}
                onChange={e => setSearchInput(e.target.value)}
                className="pl-10 pr-10 h-8 text-xs"
              />
              {searchInput && (
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={() => {
                    setSearchInput('');
                    setSearch('');
                    resetPagination();
                  }}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-600 transition-colors"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {view === 'card' && (
                <>
                  <DataTableFilter
                    title="Status"
                    multiple={false}
                    options={STATUS_OPTIONS}
                    selected={statusFilter === 'ALL' ? [] : [statusFilter]}
                    onChange={next => handleStatusChange((next[0] as StatusFilter) ?? 'ALL')}
                  />
                  <DataTableFilter
                    title="Tags"
                    options={tagFacetOptions}
                    selected={tagsFilter}
                    onChange={handleTagsFilterChange}
                  />
                </>
              )}
              {view === 'table' && (
                <DataTableViewOptions table={table} lockedColumnIds={['select', 'email', 'actions']} />
              )}
              <span className="hidden sm:block h-5 w-px bg-neutral-200" aria-hidden="true" />
              <DataTableViewSwitcher view={view} onChange={setView} />
            </div>
          </div>

          {/* Bulk action bar — appears in both views once a selection exists.
              Reuses the shared bar; the "select all matching" affordance rides in
              the `note` slot, the three async bulk operations are the children. */}
          {effectiveSelectionCount > 0 && (
            <BulkActionBar
              selectedCount={effectiveSelectionCount}
              itemNoun="contact"
              onClear={clearSelection}
              note={
                !selectAllMatching && allOnPageSelected && totalCount > contacts.length ? (
                  <button
                    type="button"
                    onClick={handleSelectAllMatching}
                    className="text-sm font-medium text-neutral-600 underline-offset-4 transition-colors hover:text-neutral-900 hover:underline focus-visible:outline-none focus-visible:underline focus-visible:text-neutral-900 whitespace-nowrap rounded-sm tabular-nums"
                  >
                    Select all {totalCount.toLocaleString()}
                    {hasActiveFilters ? ' matching' : ''}
                  </button>
                ) : selectAllMatching ? (
                  <span className="text-sm text-neutral-500 whitespace-nowrap">All matching selected</span>
                ) : null
              }
            >
              <Button variant="outline" size="sm" onClick={() => handleBulkAction('subscribe')}>
                <MailCheck className="h-4 w-4" />
                Subscribe
              </Button>
              <Button variant="outline" size="sm" onClick={() => handleBulkAction('unsubscribe')}>
                <MailX className="h-4 w-4" />
                Unsubscribe
              </Button>
              <Button variant="outline" size="sm" onClick={() => handleTagBulkAction('add')}>
                <TagIcon className="h-4 w-4" />
                Add tag
              </Button>
              <Button variant="outline" size="sm" onClick={() => handleTagBulkAction('remove')}>
                <TagIcon className="h-4 w-4" />
                Remove tag
              </Button>
              <Button variant="outline" size="sm" onClick={() => setShowSequenceBulkDialog(true)}>
                <ListOrdered className="h-4 w-4" />
                Add to sequence
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleBulkAction('delete')}
                className="text-neutral-700 transition-colors hover:bg-red-50 hover:text-red-700 hover:border-red-200"
              >
                <Trash2 className="h-4 w-4" />
                Delete
              </Button>
            </BulkActionBar>
          )}

          {/* Contacts */}
          <div>
            {isLoading && contacts.length === 0 ? (
              <Card>
                <CardContent className="pt-6">
                  <div className="flex items-center justify-center py-12">
                    <IconSpinner />
                  </div>
                </CardContent>
              </Card>
            ) : !hasData ? (
              <Card>
                <CardContent>
                  {hasActiveFilters ? (
                    // Items exist, but the active search/status filters matched
                    // none — offer a one-click recovery.
                    <NoResultsState icon={Mail} itemNoun="contacts" onClear={clearFilters} />
                  ) : (
                    // Genuinely empty project — first-run state.
                    <EmptyState
                      icon={Mail}
                      title="No contacts yet"
                      description="Add contacts to start tracking engagement."
                      action={
                        <Button onClick={() => setShowCreateDialog(true)}>
                          <Plus className="h-4 w-4" />
                          Add contact
                        </Button>
                      }
                    />
                  )}
                </CardContent>
              </Card>
            ) : view === 'card' ? (
              <>
                {/* Card grid view */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {contacts.map(contact => {
                    const selected = isContactSelected(contact.id);
                    return (
                      <Card
                        key={contact.id}
                        data-state={selected ? 'selected' : undefined}
                        className="flex flex-col transition-colors hover:border-neutral-300 data-[state=selected]:border-neutral-400 data-[state=selected]:bg-neutral-50/60"
                      >
                        <div className="flex items-start gap-3 p-4">
                          <Checkbox
                            className="mt-0.5 shrink-0"
                            checked={selected}
                            onCheckedChange={() => handleSelectContact(contact.id)}
                            aria-label={`Select ${contact.email ?? 'lead (no email)'}`}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-start justify-between gap-3">
                              <Link
                                href={`/contacts/${contact.id}`}
                                className="flex min-w-0 items-center gap-2 text-sm font-medium text-neutral-900 hover:text-neutral-700 focus-visible:outline-none focus-visible:underline"
                              >
                                {!contact.email ? (
                                  <UserPlus className="h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
                                ) : contact.subscribed ? (
                                  <MailCheck className="h-4 w-4 shrink-0 text-green-600" aria-hidden="true" />
                                ) : (
                                  <MailX className="h-4 w-4 shrink-0 text-red-600" aria-hidden="true" />
                                )}
                                <span className="truncate">
                                  {contact.email ?? <span className="italic text-neutral-500">Lead (no email)</span>}
                                </span>
                              </Link>
                              {!contact.email ? (
                                <Badge variant="warning" className="shrink-0">
                                  Lead
                                </Badge>
                              ) : (
                                <Badge variant={contact.subscribed ? 'success' : 'destructive'} className="shrink-0">
                                  {contact.subscribed ? 'Subscribed' : 'Unsubscribed'}
                                </Badge>
                              )}
                            </div>
                            {contact.tags.length > 0 && (
                              <div className="mt-2">
                                <ContactTagsCell tags={contact.tags} />
                              </div>
                            )}
                            <div className="mt-3 flex items-center justify-between">
                              <div className="group relative inline-block cursor-help">
                                <span className="text-xs text-neutral-400">
                                  Added {formatRelativeTime(contact.createdAt)}
                                </span>
                                <div className="hidden group-hover:block absolute z-10 w-48 p-2 bg-neutral-900 text-white text-xs rounded shadow-md bottom-full left-0 mb-1 whitespace-nowrap">
                                  {dayjs(contact.createdAt).format('DD MMMM YYYY, hh:mm')}
                                </div>
                              </div>
                              <div className="flex items-center gap-1">
                                <Button asChild variant="ghost" size="sm" title="Edit contact">
                                  <Link href={`/contacts/${contact.id}`} aria-label="Edit contact">
                                    <Edit className="h-4 w-4" />
                                  </Link>
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  title="Delete contact"
                                  aria-label="Delete contact"
                                  onClick={() => promptDelete(contact.id)}
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </div>
                            </div>
                          </div>
                        </div>
                      </Card>
                    );
                  })}
                </div>

                {(currentPage > 0 || data?.hasMore) && (
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mt-6">
                    <p className="text-sm text-neutral-500 tabular-nums">
                      Showing {(currentPage * pageSize + 1).toLocaleString()} to{' '}
                      {(currentPage * pageSize + contacts.length).toLocaleString()}
                      {totalCount > 0 ? ` of ${totalCount.toLocaleString()}` : ''}
                    </p>
                    <div className="flex items-center gap-2 justify-center sm:justify-end">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handlePreviousPage}
                        disabled={currentPage === 0 || isLoading}
                      >
                        <ChevronLeft className="h-4 w-4" />
                        <span className="hidden sm:inline">Previous</span>
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleNextPage}
                        disabled={!data?.hasMore || isLoading}
                      >
                        <span className="hidden sm:inline">Next</span>
                        <ChevronRight className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <>
                {/* Table view (tanstack-driven) */}
                <Card>
                  <CardContent className="p-0">
                    <DataTable table={table} getRowSelected={c => isContactSelected(c.id)} />
                  </CardContent>
                </Card>

                {(currentPage > 0 || data?.hasMore) && (
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mt-6">
                    <p className="text-sm text-neutral-500 tabular-nums">
                      Showing {(currentPage * pageSize + 1).toLocaleString()} to{' '}
                      {(currentPage * pageSize + contacts.length).toLocaleString()}
                      {totalCount > 0 ? ` of ${totalCount.toLocaleString()}` : ''}
                    </p>
                    <div className="flex items-center gap-2 justify-center sm:justify-end">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handlePreviousPage}
                        disabled={currentPage === 0 || isLoading}
                      >
                        <ChevronLeft className="h-4 w-4" />
                        <span className="hidden sm:inline">Previous</span>
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleNextPage}
                        disabled={!data?.hasMore || isLoading}
                      >
                        <span className="hidden sm:inline">Next</span>
                        <ChevronRight className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* Create Contact Dialog */}
        <CreateContactDialog open={showCreateDialog} onOpenChange={setShowCreateDialog} onSuccess={() => mutate()} />

        {/* Import Contacts Dialog */}
        <ImportContactsDialog open={showImportDialog} onOpenChange={setShowImportDialog} onSuccess={() => mutate()} />

        {/* Bulk Actions Dialog */}
        <BulkActionsDialog
          open={showBulkActionsDialog}
          onOpenChange={setShowBulkActionsDialog}
          operation={bulkOperation}
          selector={
            selectAllMatching
              ? {
                  mode: 'query',
                  // Mirror the active list filters so "select all matching"
                  // targets exactly the rows the user is looking at.
                  filter: {
                    ...(search ? {search} : {}),
                    ...(statusFilter !== 'ALL' ? {subscribed: statusFilter === 'subscribed'} : {}),
                    ...(tagsFilter.length > 0 ? {tagIds: tagsFilter} : {}),
                  },
                  excludeIds: Array.from(excludedContacts),
                }
              : {mode: 'ids', contactIds: Array.from(selectedContacts)}
          }
          targetCount={effectiveSelectionCount}
          onSuccess={() => {
            mutate();
            clearSelection();
          }}
        />

        {/* Bulk Tag Actions Dialog */}
        <TagBulkActionsDialog
          open={showTagBulkDialog}
          onOpenChange={setShowTagBulkDialog}
          action={tagBulkAction}
          selector={
            selectAllMatching
              ? {
                  mode: 'query',
                  filter: {
                    ...(search ? {search} : {}),
                    ...(statusFilter !== 'ALL' ? {subscribed: statusFilter === 'subscribed'} : {}),
                    ...(tagsFilter.length > 0 ? {tagIds: tagsFilter} : {}),
                  },
                  excludeIds: Array.from(excludedContacts),
                }
              : {mode: 'ids', contactIds: Array.from(selectedContacts)}
          }
          targetCount={effectiveSelectionCount}
          onSuccess={() => {
            mutate();
            clearSelection();
          }}
        />

        {/* Bulk Sequence Enrollment Dialog */}
        <SequenceBulkEnrollDialog
          open={showSequenceBulkDialog}
          onOpenChange={setShowSequenceBulkDialog}
          selector={
            selectAllMatching
              ? {
                  mode: 'query',
                  filter: {
                    ...(search ? {search} : {}),
                    ...(statusFilter !== 'ALL' ? {subscribed: statusFilter === 'subscribed'} : {}),
                    ...(tagsFilter.length > 0 ? {tagIds: tagsFilter} : {}),
                  },
                  excludeIds: Array.from(excludedContacts),
                }
              : {mode: 'ids', contactIds: Array.from(selectedContacts)}
          }
          targetCount={effectiveSelectionCount}
          onSuccess={() => {
            mutate();
            clearSelection();
          }}
        />

        {/* Delete Confirmation Dialog */}
        <ConfirmDialog
          open={showDeleteDialog}
          onOpenChange={setShowDeleteDialog}
          onConfirm={handleDelete}
          title="Delete this contact?"
          description="Their email and details are erased and they'll never receive email again, but their send history is kept. This can't be undone."
          confirmText="Delete contact"
          variant="destructive"
        />
      </DashboardLayout>
    </>
  );
}

interface CreateContactDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

function CreateContactDialog({open, onOpenChange, onSuccess}: CreateContactDialogProps) {
  const [email, setEmail] = useState('');
  const [subscribed, setSubscribed] = useState(true);
  const [customData, setCustomData] = useState<Record<string, string | number | boolean> | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);

    try {
      const response = await network.fetch<
        {
          _meta?: {isNew: boolean; isUpdate: boolean};
          email: string;
        },
        typeof ContactSchemas.create
      >('POST', '/contacts', {email, subscribed, data: customData});

      // Show appropriate message based on whether contact was new or updated
      if (response._meta?.isUpdate) {
        toast.success(`Contact ${response.email} already existed and was updated with new data`);
      } else {
        toast.success('Contact created');
      }

      setEmail('');
      setSubscribed(true);
      setCustomData(null);
      onOpenChange(false);
      onSuccess();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Couldn’t save the contact. Try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create new contact</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="email">Email address
            <span className="text-red-500"> *</span>
          </Label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              placeholder="contact@example.com"
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <div>
              <Label htmlFor="subscribed" className="font-medium cursor-pointer">
                Subscribed
              </Label>
              <p className="text-xs text-neutral-500 mt-0.5">
                Receive emails from campaigns and workflows.
              </p>
            </div>
            <Switch id="subscribed" checked={subscribed} onCheckedChange={setSubscribed} />
          </div>

          <KeyValueEditor key={open ? 'create' : 'closed'} initialData={customData} onChange={setCustomData} />

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Creating…' : 'Create Contact'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface ImportContactsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

interface ImportResult {
  totalRows: number;
  successCount: number;
  createdCount: number;
  updatedCount: number;
  failureCount: number;
  errors: Array<{row: number; email: string; error: string}>;
}

function ImportContactsDialog({open, onOpenChange, onSuccess}: ImportContactsDialogProps) {
  const [file, setFile] = useState<File | null>(null);
  const [, setJobId] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState<'idle' | 'uploading' | 'processing' | 'completed' | 'failed'>('idle');
  const [result, setResult] = useState<ImportResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const [showCloseConfirmDialog, setShowCloseConfirmDialog] = useState(false);

  // Helper function to truncate long file names from the middle
  const truncateFileName = (fileName: string, maxLength: number = 30) => {
    if (fileName.length <= maxLength) return fileName;

    const extension = fileName.substring(fileName.lastIndexOf('.'));
    const nameWithoutExt = fileName.substring(0, fileName.lastIndexOf('.'));
    const charsToShow = maxLength - extension.length - 3; // 3 for "..."
    const frontChars = Math.ceil(charsToShow / 2);
    const backChars = Math.floor(charsToShow / 2);

    return `${nameWithoutExt.substring(0, frontChars)}...${nameWithoutExt.substring(nameWithoutExt.length - backChars)}${extension}`;
  };

  // Clean up polling on unmount or dialog close
  useEffect(() => {
    if (!open) {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
      // Reset state when dialog closes
      setTimeout(() => {
        setFile(null);
        setJobId(null);
        setProgress(0);
        setStatus('idle');
        setResult(null);
        setErrorMessage(null);
      }, 300);
    }
  }, [open]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      // Validate file type
      if (!selectedFile.name.endsWith('.csv')) {
        toast.error('Please select a CSV file');
        return;
      }

      // Validate file size (5MB max)
      if (selectedFile.size > 5 * 1024 * 1024) {
        toast.error('File size must be less than 5MB');
        return;
      }

      setFile(selectedFile);
      setStatus('idle');
    }
  };

  const pollJobStatus = async (jobId: string) => {
    try {
      const response = await network.fetch<{
        id: string;
        state: string;
        progress: number;
        result: ImportResult | null;
        failedReason?: string;
      }>('GET', `/contacts/import/${jobId}`);

      setProgress(response.progress || 0);

      if (response.state === 'completed') {
        setStatus('completed');
        setResult(response.result);
        if (pollIntervalRef.current) {
          clearInterval(pollIntervalRef.current);
          pollIntervalRef.current = null;
        }

        // Show success message
        if (response.result) {
          const {createdCount, updatedCount, failureCount} = response.result;
          const parts = [];
          if (createdCount > 0) parts.push(`${createdCount} created`);
          if (updatedCount > 0) parts.push(`${updatedCount} updated`);
          if (failureCount > 0) parts.push(`${failureCount} failed`);

          toast.success(`Import completed: ${parts.join(', ')}`);
        }

        onSuccess();
      } else if (response.state === 'failed') {
        setStatus('failed');
        if (pollIntervalRef.current) {
          clearInterval(pollIntervalRef.current);
          pollIntervalRef.current = null;
        }
        // Store and show the specific error message if available, otherwise show generic error
        const errorMsg = response.failedReason || 'Import failed. Please check your CSV file and try again.';
        setErrorMessage(errorMsg);
        toast.error(errorMsg);
      } else if (response.state === 'active') {
        setStatus('processing');
      }
    } catch (error) {
      console.error('Failed to poll job status:', error);
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
      setStatus('failed');
      toast.error('Lost track of the import. Reopen this dialog to check on it.');
    }
  };

  const handleUpload = async () => {
    if (!file) {
      toast.error('Please select a file to upload');
      return;
    }

    setIsUploading(true);
    setStatus('uploading');

    try {
      const formData = new FormData();
      formData.append('file', file);

      const data = await network.upload<{jobId: string; message: string}>('POST', '/contacts/import', formData);

      setJobId(data.jobId);
      setStatus('processing');

      // Start polling for job status
      pollIntervalRef.current = setInterval(() => {
        void pollJobStatus(data.jobId);
      }, 1000); // Poll every second
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Couldn’t upload the file. Try again.';
      setErrorMessage(errorMsg);
      toast.error(errorMsg);
      setStatus('failed');
    } finally {
      setIsUploading(false);
    }
  };

  const handleClose = () => {
    if (status === 'processing') {
      setShowCloseConfirmDialog(true);
      return;
    }
    onOpenChange(false);
  };

  const confirmClose = () => {
    onOpenChange(false);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={handleClose}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Import contacts from CSV</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            {/* Instructions */}
            <div className="text-sm text-neutral-500 space-y-1">
              <p>Required column: <code className="text-neutral-700 bg-neutral-100 px-1 py-0.5 rounded text-xs">email</code>. Optional: <code className="text-neutral-700 bg-neutral-100 px-1 py-0.5 rounded text-xs">subscribed</code> (true/false) and any custom fields. Max 5MB.</p>
            </div>

            {/* File Upload */}
            {status === 'idle' || status === 'failed' ? (
              <div>
                <Label htmlFor="csv-file">Select CSV file</Label>
                <div className="mt-2">
                  <input
                    ref={fileInputRef}
                    id="csv-file"
                    type="file"
                    accept=".csv"
                    onChange={handleFileChange}
                    className="hidden"
                  />
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={() => fileInputRef.current?.click()}
                    type="button"
                  >
                    <FileUp className="h-4 w-4 mr-2" />
                    {file ? truncateFileName(file.name) : 'Choose CSV File'}
                  </Button>
                </div>
              </div>
            ) : null}

            {/* Progress */}
            {(status === 'uploading' || status === 'processing') && (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-neutral-600">
                    {status === 'uploading' ? 'Uploading file…' : 'Processing contacts…'}
                  </span>
                  <span className="text-neutral-900 font-medium">{progress}%</span>
                </div>
                <div className="w-full bg-neutral-200 rounded-full h-1.5">
                  <div
                    className="bg-neutral-900 h-1.5 rounded-full transition-all duration-300"
                    style={{width: `${progress}%`}}
                  />
                </div>
              </div>
            )}

            {/* Results */}
            {status === 'completed' && result && (
              <div className="space-y-3">
                <div className="flex items-center gap-1.5 text-sm text-neutral-600">
                  <CheckCircle className="h-4 w-4 text-green-600 flex-shrink-0" />
                  <span>
                    <span className="font-medium text-neutral-900">{result.totalRows}</span> processed —{' '}
                    <span className="text-neutral-900">{result.createdCount}</span> created,{' '}
                    <span className="text-neutral-900">{result.updatedCount}</span> updated
                    {result.failureCount > 0 && (
                      <>, <span className="text-red-600">{result.failureCount}</span> failed</>
                    )}
                  </span>
                </div>

                {/* Error Details */}
                {result.errors && result.errors.length > 0 && (
                  <div className="max-h-40 overflow-y-auto border border-neutral-200 rounded-md">
                    <div className="space-y-0 text-xs text-neutral-600">
                      {result.errors.slice(0, 10).map((error, idx) => (
                        <div key={idx} className="flex gap-3 px-3 py-2 border-b border-neutral-100 last:border-0">
                          <span className="font-mono text-neutral-400 flex-shrink-0">Row {error.row}</span>
                          <span className="text-red-600">{error.email || 'N/A'} — {error.error}</span>
                        </div>
                      ))}
                      {result.errors.length > 10 && (
                        <div className="px-3 py-2 text-neutral-500">
                          +{result.errors.length - 10} more errors
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {status === 'failed' && (
              <div className="flex items-start gap-2 text-sm">
                <XCircle className="h-4 w-4 text-red-500 mt-0.5 flex-shrink-0" />
                <p className="text-red-600">{errorMessage || 'Please check your CSV file and try again.'}</p>
              </div>
            )}
          </div>

          <DialogFooter>
            {status === 'idle' || status === 'failed' ? (
              <>
                <Button type="button" variant="outline" onClick={handleClose}>
                  Cancel
                </Button>
                <Button type="button" onClick={handleUpload} disabled={!file || isUploading}>
                  {isUploading ? 'Uploading…' : 'Import Contacts'}
                </Button>
              </>
            ) : status === 'completed' ? (
              <Button type="button" onClick={handleClose}>
                Close
              </Button>
            ) : (
              <Button type="button" variant="outline" onClick={handleClose}>
                Close
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={showCloseConfirmDialog}
        onOpenChange={setShowCloseConfirmDialog}
        onConfirm={confirmClose}
        title="Close while the import is running?"
        description="The import keeps running in the background. You just won't see the result here."
        cancelText="Keep watching"
        confirmText="Close anyway"
        variant="destructive"
      />
    </>
  );
}

type BulkSelector =
  | {mode: 'ids'; contactIds: string[]}
  | {mode: 'query'; filter: {search?: string; subscribed?: boolean; tagIds?: string[]}; excludeIds: string[]};

interface BulkActionsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  operation: 'subscribe' | 'unsubscribe' | 'delete' | null;
  selector: BulkSelector;
  targetCount: number;
  onSuccess: () => void;
}

interface BulkActionResult {
  operation: 'subscribe' | 'unsubscribe' | 'delete';
  totalRequested: number;
  /** Contacts whose state was actually changed by this run. */
  successCount: number;
  /** Subscribe/unsubscribe only: contacts that were already in the target state. */
  unchangedCount: number;
  /** Contacts that errored or weren't found. */
  failureCount: number;
  errors: Array<{contactId: string; email: string; error: string}>;
}

function BulkActionsDialog({open, onOpenChange, operation, selector, targetCount, onSuccess}: BulkActionsDialogProps) {
  const [, setJobId] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState<'idle' | 'processing' | 'completed' | 'failed'>('idle');
  const [result, setResult] = useState<BulkActionResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const [showCloseConfirmDialog, setShowCloseConfirmDialog] = useState(false);

  // Clean up polling on unmount or dialog close
  useEffect(() => {
    if (!open) {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
      setTimeout(() => {
        setJobId(null);
        setProgress(0);
        setStatus('idle');
        setResult(null);
        setErrorMessage(null);
      }, 300);
    }
  }, [open]);

  const pollJobStatus = async (jobId: string) => {
    try {
      const response = await network.fetch<{
        id: string;
        state: string;
        progress: number;
        result: BulkActionResult | null;
        failedReason?: string;
      }>('GET', `/contacts/bulk/${jobId}`);

      setProgress(response.progress || 0);

      if (response.state === 'completed') {
        setStatus('completed');
        setResult(response.result);
        if (pollIntervalRef.current) {
          clearInterval(pollIntervalRef.current);
          pollIntervalRef.current = null;
        }

        if (response.result) {
          toast.success(buildToastSummary(response.result));
        }

        onSuccess();
      } else if (response.state === 'failed') {
        setStatus('failed');
        if (pollIntervalRef.current) {
          clearInterval(pollIntervalRef.current);
          pollIntervalRef.current = null;
        }
        const errorMsg = response.failedReason || 'Operation failed';
        setErrorMessage(errorMsg);
        toast.error(errorMsg);
      } else if (response.state === 'active') {
        setStatus('processing');
      }
    } catch (error) {
      console.error('Failed to poll job status:', error);
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
      setStatus('failed');
      toast.error('Lost track of the job. It may still be running.');
    }
  };

  const handleConfirm = async () => {
    if (!operation) return;

    setIsProcessing(true);
    setStatus('processing');

    try {
      const endpoint = `/contacts/bulk-${operation}`;
      const data = await network.fetch<{jobId: string; message: string}, typeof ContactSchemas.bulkAction>(
        'POST',
        endpoint,
        selector,
      );

      setJobId(data.jobId);

      // Start polling for job status
      pollIntervalRef.current = setInterval(() => {
        void pollJobStatus(data.jobId);
      }, 1000);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Couldn’t start the job. Try again.';
      setErrorMessage(errorMsg);
      toast.error(errorMsg);
      setStatus('failed');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleClose = () => {
    if (status === 'processing') {
      setShowCloseConfirmDialog(true);
      return;
    }
    onOpenChange(false);
  };

  const confirmClose = () => {
    onOpenChange(false);
  };

  const copy = getOperationCopy(operation);

  const isQueueing = status === 'processing' && progress === 0;
  const dialogTitle =
    status === 'completed'
      ? copy.completedTitle
      : status === 'processing'
      ? copy.progressTitle
      : status === 'failed'
      ? copy.failedTitle
      : copy.title;

  const handleRetry = () => {
    setErrorMessage(null);
    setStatus('idle');
    void handleConfirm();
  };

  return (
    <>
      <Dialog open={open} onOpenChange={handleClose}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="transition-colors">{dialogTitle}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            {status === 'idle' && (
              <div className="space-y-3 motion-safe:animate-in motion-safe:fade-in-50 motion-safe:duration-200">
                <p className="text-sm text-neutral-700 leading-relaxed">
                  {copy.confirmVerb}{' '}
                  <span className="font-medium text-neutral-900 tabular-nums">
                    {targetCount.toLocaleString()} contact{targetCount !== 1 ? 's' : ''}
                  </span>
                  ?
                  {copy.skipNote && <span className="text-neutral-500"> {copy.skipNote}</span>}
                </p>
                {operation === 'delete' && (
                  <div className="flex items-start gap-2.5 rounded-md border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-700">
                    <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" strokeWidth={2.25} />
                    <p className="leading-relaxed">
                      <span className="font-medium">This action cannot be undone.</span> Contacts and their event history will be permanently removed.
                    </p>
                  </div>
                )}
                {selector.mode === 'query' && (
                  <p className="text-xs text-neutral-500 leading-relaxed">
                    Contacts are evaluated when the job runs — any added in the meantime may also be included.
                  </p>
                )}
              </div>
            )}

            {status === 'processing' && (
              <div className="space-y-3 py-1 motion-safe:animate-in motion-safe:fade-in-50 motion-safe:duration-200">
                <div className="flex items-baseline justify-between text-sm">
                  <span className="flex items-center gap-2 text-neutral-600">
                    {isQueueing && <Loader2 className="h-3.5 w-3.5 animate-spin text-neutral-400" />}
                    <span>
                      {isQueueing
                        ? 'Queued — starting up…'
                        : `${copy.processingLabel} ${targetCount.toLocaleString()} contact${targetCount !== 1 ? 's' : ''}`}
                    </span>
                  </span>
                  <span
                    className={`tabular-nums font-medium transition-opacity ${
                      isQueueing ? 'text-neutral-400' : 'text-neutral-900'
                    }`}
                  >
                    {progress}%
                  </span>
                </div>
                <div className="relative w-full bg-neutral-100 rounded-full h-1.5 overflow-hidden">
                  {isQueueing ? (
                    <div className="absolute inset-y-0 left-0 w-1/3 rounded-full bg-neutral-300 motion-safe:animate-[indeterminate_1.4s_ease-in-out_infinite]" />
                  ) : (
                    <div
                      className="bg-neutral-900 h-full rounded-full transition-[width] duration-500 ease-out"
                      style={{width: `${progress}%`}}
                    />
                  )}
                </div>
              </div>
            )}

            {status === 'completed' && result && <BulkResultSummary result={result} />}

            {status === 'failed' && (
              <div className="flex items-start gap-2.5 rounded-md border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700 motion-safe:animate-in motion-safe:fade-in-50 motion-safe:duration-200">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={2.25} />
                <p className="leading-relaxed">{errorMessage || 'Something went wrong. Please try again.'}</p>
              </div>
            )}
          </div>

          <DialogFooter>
            {status === 'idle' ? (
              <>
                <Button type="button" variant="outline" onClick={handleClose}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  onClick={handleConfirm}
                  disabled={isProcessing}
                  variant={operation === 'delete' ? 'destructive' : 'default'}
                >
                  {isProcessing ? 'Starting…' : copy.confirmButton}
                </Button>
              </>
            ) : status === 'failed' ? (
              <>
                <Button type="button" variant="outline" onClick={handleClose}>
                  Close
                </Button>
                <Button type="button" onClick={handleRetry} variant={operation === 'delete' ? 'destructive' : 'default'}>
                  Try again
                </Button>
              </>
            ) : (
              <Button
                type="button"
                onClick={handleClose}
                variant={status === 'completed' ? 'default' : 'outline'}
              >
                {status === 'completed' ? 'Done' : 'Hide'}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={showCloseConfirmDialog}
        onOpenChange={setShowCloseConfirmDialog}
        onConfirm={confirmClose}
        title="Hide this dialog?"
        description="The job keeps running and your contacts are still updated. You just won't see the result here."
        cancelText="Keep watching"
        confirmText="Hide"
        variant="default"
      />
    </>
  );
}

type TagBulkSelector =
  | {mode: 'ids'; contactIds: string[]}
  | {mode: 'query'; filter: {search?: string; subscribed?: boolean; tagIds?: string[]}; excludeIds: string[]};

interface TagBulkResult {
  action: 'add' | 'remove';
  totalRequested: number;
  successCount: number;
  unchangedCount: number;
  failureCount: number;
}

interface TagBulkActionsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  action: 'add' | 'remove' | null;
  selector: TagBulkSelector;
  targetCount: number;
  onSuccess: () => void;
}

function TagBulkActionsDialog({open, onOpenChange, action, selector, targetCount, onSuccess}: TagBulkActionsDialogProps) {
  const {data: tags} = useSWR<Tag[]>(open ? '/tags' : null, {revalidateOnFocus: false});
  const [tagId, setTagId] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState<'idle' | 'processing' | 'completed' | 'failed'>('idle');
  const [result, setResult] = useState<TagBulkResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const [showCloseConfirmDialog, setShowCloseConfirmDialog] = useState(false);

  useEffect(() => {
    if (!open) {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
      setTimeout(() => {
        setTagId('');
        setProgress(0);
        setStatus('idle');
        setResult(null);
        setErrorMessage(null);
      }, 300);
    }
  }, [open]);

  const pollJobStatus = async (jobId: string) => {
    try {
      const response = await network.fetch<{
        id: string;
        state: string;
        progress: number;
        result: TagBulkResult | null;
        failedReason?: string;
      }>('GET', `/tags/bulk-apply/${jobId}`);

      setProgress(response.progress || 0);

      if (response.state === 'completed') {
        setStatus('completed');
        setResult(response.result);
        if (pollIntervalRef.current) {
          clearInterval(pollIntervalRef.current);
          pollIntervalRef.current = null;
        }
        if (response.result) {
          toast.success(buildTagToastSummary(response.result));
        }
        onSuccess();
      } else if (response.state === 'failed') {
        setStatus('failed');
        if (pollIntervalRef.current) {
          clearInterval(pollIntervalRef.current);
          pollIntervalRef.current = null;
        }
        const errorMsg = response.failedReason || 'Operation failed';
        setErrorMessage(errorMsg);
        toast.error(errorMsg);
      } else if (response.state === 'active') {
        setStatus('processing');
      }
    } catch (error) {
      console.error('Failed to poll job status:', error);
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
      setStatus('failed');
      toast.error('Lost track of the job. It may still be running.');
    }
  };

  const handleConfirm = async () => {
    if (!action || !tagId) return;

    setIsProcessing(true);
    setStatus('processing');

    try {
      const body =
        selector.mode === 'ids'
          ? {mode: 'ids' as const, contactIds: selector.contactIds, tagIds: [tagId], action}
          : {mode: 'query' as const, filter: selector.filter, excludeIds: selector.excludeIds, tagIds: [tagId], action};

      const data = await network.fetch<{jobId: string; message: string}, typeof TagSchemas.bulkApply>(
        'POST',
        '/tags/bulk-apply',
        body,
      );

      pollIntervalRef.current = setInterval(() => {
        void pollJobStatus(data.jobId);
      }, 1000);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Couldn’t start the job. Try again.';
      setErrorMessage(errorMsg);
      toast.error(errorMsg);
      setStatus('failed');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleClose = () => {
    if (status === 'processing') {
      setShowCloseConfirmDialog(true);
      return;
    }
    onOpenChange(false);
  };

  const confirmClose = () => {
    onOpenChange(false);
  };

  const actionLabel = action === 'remove' ? 'Remove tag' : 'Add tag';
  const isQueueing = status === 'processing' && progress === 0;
  const dialogTitle =
    status === 'completed'
      ? `${actionLabel} complete`
      : status === 'processing'
      ? `${actionLabel}…`
      : status === 'failed'
      ? `${actionLabel} failed`
      : actionLabel;

  const handleRetry = () => {
    setErrorMessage(null);
    setStatus('idle');
    void handleConfirm();
  };

  return (
    <>
      <Dialog open={open} onOpenChange={handleClose}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="transition-colors">{dialogTitle}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            {status === 'idle' && (
              <div className="space-y-3 motion-safe:animate-in motion-safe:fade-in-50 motion-safe:duration-200">
                <p className="text-sm text-neutral-700 leading-relaxed">
                  {action === 'remove' ? 'Remove a tag from' : 'Apply a tag to'}{' '}
                  <span className="font-medium text-neutral-900 tabular-nums">
                    {targetCount.toLocaleString()} contact{targetCount !== 1 ? 's' : ''}
                  </span>
                  .
                </p>
                <div className="space-y-1.5">
                  <Label htmlFor="bulkTagId">Tag</Label>
                  <select
                    id="bulkTagId"
                    value={tagId}
                    onChange={e => setTagId(e.target.value)}
                    className="flex h-9 w-full rounded-md border border-neutral-200 bg-white px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neutral-950"
                  >
                    <option value="" disabled>
                      Select a tag…
                    </option>
                    {(tags ?? []).map(tag => (
                      <option key={tag.id} value={tag.id}>
                        {tag.name}
                      </option>
                    ))}
                  </select>
                </div>
                {selector.mode === 'query' && (
                  <p className="text-xs text-neutral-500 leading-relaxed">
                    Contacts are evaluated when the job runs — any added in the meantime may also be included.
                  </p>
                )}
              </div>
            )}

            {status === 'processing' && (
              <div className="space-y-3 py-1 motion-safe:animate-in motion-safe:fade-in-50 motion-safe:duration-200">
                <div className="flex items-baseline justify-between text-sm">
                  <span className="flex items-center gap-2 text-neutral-600">
                    {isQueueing && <Loader2 className="h-3.5 w-3.5 animate-spin text-neutral-400" />}
                    <span>
                      {isQueueing
                        ? 'Queued — starting up…'
                        : `${actionLabel === 'Add tag' ? 'Tagging' : 'Untagging'} ${targetCount.toLocaleString()} contact${
                            targetCount !== 1 ? 's' : ''
                          }`}
                    </span>
                  </span>
                  <span
                    className={`tabular-nums font-medium transition-opacity ${
                      isQueueing ? 'text-neutral-400' : 'text-neutral-900'
                    }`}
                  >
                    {progress}%
                  </span>
                </div>
                <div className="relative w-full bg-neutral-100 rounded-full h-1.5 overflow-hidden">
                  {isQueueing ? (
                    <div className="absolute inset-y-0 left-0 w-1/3 rounded-full bg-neutral-300 motion-safe:animate-[indeterminate_1.4s_ease-in-out_infinite]" />
                  ) : (
                    <div
                      className="bg-neutral-900 h-full rounded-full transition-[width] duration-500 ease-out"
                      style={{width: `${progress}%`}}
                    />
                  )}
                </div>
              </div>
            )}

            {status === 'completed' && result && (
              <div className="space-y-2 text-sm motion-safe:animate-in motion-safe:fade-in-50 motion-safe:duration-200">
                <div className="flex items-center gap-2 text-neutral-700">
                  <CheckCircle className="h-4 w-4 text-green-600" />
                  <span>
                    {result.successCount.toLocaleString()} contact{result.successCount !== 1 ? 's' : ''} updated
                  </span>
                </div>
                {result.unchangedCount > 0 && (
                  <div className="flex items-center gap-2 text-neutral-500">
                    <Check className="h-4 w-4" />
                    <span>{result.unchangedCount.toLocaleString()} already in that state</span>
                  </div>
                )}
                {result.failureCount > 0 && (
                  <div className="flex items-center gap-2 text-red-600">
                    <XCircle className="h-4 w-4" />
                    <span>{result.failureCount.toLocaleString()} failed</span>
                  </div>
                )}
              </div>
            )}

            {status === 'failed' && (
              <div className="flex items-start gap-2.5 rounded-md border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700 motion-safe:animate-in motion-safe:fade-in-50 motion-safe:duration-200">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={2.25} />
                <p className="leading-relaxed">{errorMessage || 'Something went wrong. Please try again.'}</p>
              </div>
            )}
          </div>

          <DialogFooter>
            {status === 'idle' ? (
              <>
                <Button type="button" variant="outline" onClick={handleClose}>
                  Cancel
                </Button>
                <Button type="button" onClick={handleConfirm} disabled={isProcessing || !tagId}>
                  {isProcessing ? 'Starting…' : actionLabel}
                </Button>
              </>
            ) : status === 'failed' ? (
              <>
                <Button type="button" variant="outline" onClick={handleClose}>
                  Close
                </Button>
                <Button type="button" onClick={handleRetry}>
                  Try again
                </Button>
              </>
            ) : (
              <Button type="button" onClick={handleClose} variant={status === 'completed' ? 'default' : 'outline'}>
                {status === 'completed' ? 'Done' : 'Hide'}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={showCloseConfirmDialog}
        onOpenChange={setShowCloseConfirmDialog}
        onConfirm={confirmClose}
        title="Hide this dialog?"
        description="The job keeps running and your contacts are still updated. You just won't see the result here."
        cancelText="Keep watching"
        confirmText="Hide"
        variant="default"
      />
    </>
  );
}

function buildTagToastSummary(result: TagBulkResult): string {
  const parts: string[] = [];
  if (result.successCount > 0) {
    parts.push(`${result.successCount.toLocaleString()} contact${result.successCount !== 1 ? 's' : ''} updated`);
  }
  if (result.failureCount > 0) {
    parts.push(`${result.failureCount.toLocaleString()} failed`);
  }
  return parts.length > 0 ? parts.join(', ') : 'No contacts needed updating';
}

interface SequenceEnrollResult {
  enrolledCount: number;
  skippedCount: number;
}

interface SequenceBulkEnrollDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selector: TagBulkSelector;
  targetCount: number;
  onSuccess: () => void;
}

function SequenceBulkEnrollDialog({
  open,
  onOpenChange,
  selector,
  targetCount,
  onSuccess,
}: SequenceBulkEnrollDialogProps) {
  const {data: sequences} = useSWR<{id: string; name: string; status: string}[]>(open ? '/sequences' : null, {
    revalidateOnFocus: false,
  });
  const [sequenceId, setSequenceId] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState<'idle' | 'processing' | 'completed' | 'failed'>('idle');
  const [result, setResult] = useState<SequenceEnrollResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const [showCloseConfirmDialog, setShowCloseConfirmDialog] = useState(false);

  // DRAFT sequences reject enrollment server-side, so don't offer them.
  const enrollable = (sequences ?? []).filter(sequence => sequence.status !== 'DRAFT');

  useEffect(() => {
    if (!open) {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
      setTimeout(() => {
        setSequenceId('');
        setProgress(0);
        setStatus('idle');
        setResult(null);
        setErrorMessage(null);
      }, 300);
    }
  }, [open]);

  const finish = (outcome: SequenceEnrollResult) => {
    setStatus('completed');
    setResult(outcome);
    toast.success(
      outcome.enrolledCount > 0
        ? `${outcome.enrolledCount.toLocaleString()} contact${outcome.enrolledCount !== 1 ? 's' : ''} enrolled`
        : 'Everyone selected was already enrolled',
    );
    onSuccess();
  };

  const pollJobStatus = async (jobId: string) => {
    try {
      const response = await network.fetch<{
        id: string;
        state: string;
        progress: number;
        result: SequenceEnrollResult | null;
        failedReason?: string;
      }>('GET', `/sequences/${sequenceId}/contacts/${jobId}`);

      setProgress(response.progress || 0);

      if (response.state === 'completed') {
        if (pollIntervalRef.current) {
          clearInterval(pollIntervalRef.current);
          pollIntervalRef.current = null;
        }
        finish(response.result ?? {enrolledCount: 0, skippedCount: 0});
      } else if (response.state === 'failed') {
        setStatus('failed');
        if (pollIntervalRef.current) {
          clearInterval(pollIntervalRef.current);
          pollIntervalRef.current = null;
        }
        const errorMsg = response.failedReason || 'Enrollment failed';
        setErrorMessage(errorMsg);
        toast.error(errorMsg);
      } else if (response.state === 'active') {
        setStatus('processing');
      }
    } catch (error) {
      console.error('Failed to poll enrollment status:', error);
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
      setStatus('failed');
      toast.error('Lost track of the job. It may still be running.');
    }
  };

  const handleConfirm = async () => {
    if (!sequenceId) return;

    setIsProcessing(true);
    setStatus('processing');

    try {
      const body =
        selector.mode === 'ids'
          ? {mode: 'ids' as const, contactIds: selector.contactIds}
          : {mode: 'query' as const, filter: selector.filter, excludeIds: selector.excludeIds};

      // Small id lists come back enrolled already; anything bigger returns a job to poll.
      const data = await network.fetch<
        {enrolled: number; skipped: number} | {jobId: string; message: string},
        typeof SequenceSchemas.enroll
      >('POST', `/sequences/${sequenceId}/contacts`, body);

      if ('jobId' in data) {
        pollIntervalRef.current = setInterval(() => {
          void pollJobStatus(data.jobId);
        }, 1000);
      } else {
        setProgress(100);
        finish({enrolledCount: data.enrolled, skippedCount: data.skipped});
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Couldn’t start the enrollment. Try again.';
      setErrorMessage(errorMsg);
      toast.error(errorMsg);
      setStatus('failed');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleClose = () => {
    if (status === 'processing') {
      setShowCloseConfirmDialog(true);
      return;
    }
    onOpenChange(false);
  };

  const isQueueing = status === 'processing' && progress === 0;
  const dialogTitle =
    status === 'completed'
      ? 'Enrollment complete'
      : status === 'processing'
      ? 'Adding to sequence…'
      : status === 'failed'
      ? 'Enrollment failed'
      : 'Add to sequence';

  return (
    <>
      <Dialog open={open} onOpenChange={handleClose}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="transition-colors">{dialogTitle}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            {status === 'idle' && (
              <div className="space-y-3 motion-safe:animate-in motion-safe:fade-in-50 motion-safe:duration-200">
                <p className="text-sm text-neutral-700 leading-relaxed">
                  Enroll{' '}
                  <span className="font-medium text-neutral-900 tabular-nums">
                    {targetCount.toLocaleString()} contact{targetCount !== 1 ? 's' : ''}
                  </span>{' '}
                  into a sequence. They start at the first email.
                </p>
                <div className="space-y-1.5">
                  <Label htmlFor="bulkSequenceId">Sequence</Label>
                  <select
                    id="bulkSequenceId"
                    value={sequenceId}
                    onChange={e => setSequenceId(e.target.value)}
                    className="flex h-9 w-full rounded-md border border-neutral-200 bg-white px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neutral-950"
                  >
                    <option value="" disabled>
                      Select a sequence…
                    </option>
                    {enrollable.map(sequence => (
                      <option key={sequence.id} value={sequence.id}>
                        {sequence.name}
                        {sequence.status === 'PAUSED' ? ' (paused)' : ''}
                      </option>
                    ))}
                  </select>
                  {enrollable.length === 0 && (
                    <p className="text-xs text-neutral-500">
                      No sequences are ready yet — a sequence has to be active or paused before contacts can join.
                    </p>
                  )}
                </div>
                {selector.mode === 'query' && (
                  <p className="text-xs text-neutral-500 leading-relaxed">
                    Contacts are evaluated when the job runs — any added in the meantime may also be included.
                  </p>
                )}
              </div>
            )}

            {status === 'processing' && (
              <div className="space-y-3 py-1 motion-safe:animate-in motion-safe:fade-in-50 motion-safe:duration-200">
                <div className="flex items-baseline justify-between text-sm">
                  <span className="flex items-center gap-2 text-neutral-600">
                    {isQueueing && <Loader2 className="h-3.5 w-3.5 animate-spin text-neutral-400" />}
                    <span>
                      {isQueueing
                        ? 'Queued — starting up…'
                        : `Enrolling ${targetCount.toLocaleString()} contact${targetCount !== 1 ? 's' : ''}`}
                    </span>
                  </span>
                  <span
                    className={`tabular-nums font-medium transition-opacity ${
                      isQueueing ? 'text-neutral-400' : 'text-neutral-900'
                    }`}
                  >
                    {progress}%
                  </span>
                </div>
                <div className="relative w-full bg-neutral-100 rounded-full h-1.5 overflow-hidden">
                  {isQueueing ? (
                    <div className="absolute inset-y-0 left-0 w-1/3 rounded-full bg-neutral-300 motion-safe:animate-[indeterminate_1.4s_ease-in-out_infinite]" />
                  ) : (
                    <div
                      className="bg-neutral-900 h-full rounded-full transition-[width] duration-500 ease-out"
                      style={{width: `${progress}%`}}
                    />
                  )}
                </div>
              </div>
            )}

            {status === 'completed' && result && (
              <div className="space-y-2 text-sm motion-safe:animate-in motion-safe:fade-in-50 motion-safe:duration-200">
                <div className="flex items-center gap-2 text-neutral-700">
                  <CheckCircle className="h-4 w-4 text-green-600" />
                  <span>
                    {result.enrolledCount.toLocaleString()} contact{result.enrolledCount !== 1 ? 's' : ''} enrolled
                  </span>
                </div>
                {result.skippedCount > 0 && (
                  <div className="flex items-center gap-2 text-neutral-500">
                    <Check className="h-4 w-4" />
                    <span>{result.skippedCount.toLocaleString()} already enrolled</span>
                  </div>
                )}
              </div>
            )}

            {status === 'failed' && (
              <div className="flex items-start gap-2.5 rounded-md border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700 motion-safe:animate-in motion-safe:fade-in-50 motion-safe:duration-200">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={2.25} />
                <p className="leading-relaxed">{errorMessage || 'Something went wrong. Please try again.'}</p>
              </div>
            )}
          </div>

          <DialogFooter>
            {status === 'idle' ? (
              <>
                <Button type="button" variant="outline" onClick={handleClose}>
                  Cancel
                </Button>
                <Button type="button" onClick={handleConfirm} disabled={isProcessing || !sequenceId}>
                  {isProcessing ? 'Starting…' : 'Add to sequence'}
                </Button>
              </>
            ) : status === 'failed' ? (
              <>
                <Button type="button" variant="outline" onClick={handleClose}>
                  Close
                </Button>
                <Button
                  type="button"
                  onClick={() => {
                    setErrorMessage(null);
                    setStatus('idle');
                    void handleConfirm();
                  }}
                >
                  Try again
                </Button>
              </>
            ) : (
              <Button type="button" onClick={handleClose} variant={status === 'completed' ? 'default' : 'outline'}>
                {status === 'completed' ? 'Done' : 'Hide'}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={showCloseConfirmDialog}
        onOpenChange={setShowCloseConfirmDialog}
        onConfirm={() => onOpenChange(false)}
        title="Hide this dialog?"
        description="The job keeps running and your contacts are still enrolled. You just won't see the result here."
        cancelText="Keep watching"
        confirmText="Hide"
        variant="default"
      />
    </>
  );
}

const MAX_VISIBLE_ROW_TAGS = 2;

function ContactTagsCell({tags}: {tags: {id: string; name: string}[]}) {
  if (tags.length === 0) return <span className="text-sm text-neutral-400">—</span>;

  const visible = tags.slice(0, MAX_VISIBLE_ROW_TAGS);
  const remaining = tags.length - visible.length;

  return (
    <div className="flex flex-wrap items-center gap-1">
      {visible.map(tag => (
        <Badge key={tag.id} variant="secondary" className="whitespace-nowrap">
          {tag.name}
        </Badge>
      ))}
      {remaining > 0 && <span className="text-xs text-neutral-400">+{remaining}</span>}
    </div>
  );
}

interface OperationCopy {
  title: string;
  progressTitle: string;
  completedTitle: string;
  failedTitle: string;
  confirmVerb: string;
  confirmButton: string;
  processingLabel: string;
  /** Past-tense verb used in result rows: "12 subscribed". */
  changedVerb: string;
  /** Result-state noun phrase: "contacts subscribed" — pluralisation handled separately. */
  summaryNoun: string;
  /** Past participle for "already X": "already subscribed". null = no skip case. */
  alreadyState: string | null;
  /** Note shown next to the confirm prompt for ops with skip semantics. */
  skipNote: string | null;
}

function getOperationCopy(operation: 'subscribe' | 'unsubscribe' | 'delete' | null): OperationCopy {
  switch (operation) {
    case 'subscribe':
      return {
        title: 'Subscribe contacts',
        progressTitle: 'Subscribing…',
        completedTitle: 'Subscribed',
        failedTitle: "Couldn't subscribe contacts",
        confirmVerb: 'Subscribe',
        confirmButton: 'Subscribe',
        processingLabel: 'Subscribing',
        changedVerb: 'subscribed',
        summaryNoun: 'subscribed',
        alreadyState: 'already subscribed',
        skipNote: 'Already-subscribed contacts will be skipped.',
      };
    case 'unsubscribe':
      return {
        title: 'Unsubscribe contacts',
        progressTitle: 'Unsubscribing…',
        completedTitle: 'Unsubscribed',
        failedTitle: "Couldn't unsubscribe contacts",
        confirmVerb: 'Unsubscribe',
        confirmButton: 'Unsubscribe',
        processingLabel: 'Unsubscribing',
        changedVerb: 'unsubscribed',
        summaryNoun: 'unsubscribed',
        alreadyState: 'already unsubscribed',
        skipNote: 'Already-unsubscribed contacts will be skipped.',
      };
    case 'delete':
      return {
        title: 'Delete contacts',
        progressTitle: 'Deleting…',
        completedTitle: 'Deleted',
        failedTitle: "Couldn't delete contacts",
        confirmVerb: 'Permanently delete',
        confirmButton: 'Delete',
        processingLabel: 'Deleting',
        changedVerb: 'deleted',
        summaryNoun: 'removed',
        alreadyState: 'already deleted',
        skipNote: 'Already-deleted contacts will be skipped.',
      };
    default:
      return {
        title: 'Process contacts',
        progressTitle: 'Processing…',
        completedTitle: 'Done',
        failedTitle: 'Operation failed',
        confirmVerb: 'Process',
        confirmButton: 'Process',
        processingLabel: 'Processing',
        changedVerb: 'processed',
        summaryNoun: 'processed',
        alreadyState: null,
        skipNote: null,
      };
  }
}

function buildToastSummary(result: BulkActionResult): string {
  const copy = getOperationCopy(result.operation);
  const parts: string[] = [];
  if (result.successCount > 0) parts.push(`${result.successCount.toLocaleString()} ${copy.changedVerb}`);
  if (result.unchangedCount > 0 && copy.alreadyState) {
    parts.push(`${result.unchangedCount.toLocaleString()} ${copy.alreadyState}`);
  }
  if (result.failureCount > 0) parts.push(`${result.failureCount.toLocaleString()} failed`);
  if (parts.length === 0) return 'No contacts to update';
  return parts.join(' · ');
}

function BulkResultSummary({result}: {result: BulkActionResult}) {
  const copy = getOperationCopy(result.operation);
  const {successCount, unchangedCount, failureCount} = result;
  const noChanges = successCount === 0 && failureCount === 0 && unchangedCount > 0;
  const total = successCount + unchangedCount + failureCount;

  // Build the row list. The "primary" row is the row that represents what the
  // user actually got — usually the changed count, but when nothing changed we
  // promote the "already in state" row so the summary still has a clear lead.
  type Row = {
    key: string;
    label: string;
    count: number;
    primary?: boolean;
    tone?: 'default' | 'danger';
  };
  const rows: Row[] = [];

  if (noChanges && copy.alreadyState) {
    rows.push({key: 'already', label: copy.alreadyState, count: unchangedCount, primary: true});
  } else {
    rows.push({key: 'changed', label: copy.completedTitle, count: successCount, primary: true});
    if (unchangedCount > 0 && copy.alreadyState) {
      rows.push({key: 'already', label: copy.alreadyState, count: unchangedCount});
    }
  }
  if (failureCount > 0) {
    rows.push({key: 'failed', label: 'Failed', count: failureCount, tone: 'danger'});
  }

  return (
    <div className="space-y-3 motion-safe:animate-in motion-safe:fade-in-50 motion-safe:slide-in-from-bottom-1 motion-safe:duration-300">
      <div className="rounded-lg border border-neutral-200 overflow-hidden divide-y divide-neutral-100">
        {rows.map(row => {
          const isPrimary = !!row.primary;
          const isDanger = row.tone === 'danger';
          return (
            <div
              key={row.key}
              className={`flex items-center gap-3 px-4 ${isPrimary ? 'py-4' : 'py-2.5'}`}
            >
              {/* Status mark — only on the primary row. Subsequent rows leave the
                  same column blank to keep the labels in a single visual track. */}
              <div className="w-7 shrink-0 flex items-center">
                {isPrimary && (
                  <div
                    className={`flex h-7 w-7 items-center justify-center rounded-full ${
                      noChanges ? 'bg-neutral-100 text-neutral-500' : 'bg-neutral-900 text-white'
                    }`}
                  >
                    {noChanges ? (
                      <Minus className="h-3.5 w-3.5" />
                    ) : (
                      <Check className="h-3.5 w-3.5" strokeWidth={3} />
                    )}
                  </div>
                )}
              </div>
              <div
                className={`flex-1 first-letter:capitalize ${
                  isPrimary
                    ? 'text-sm font-medium text-neutral-900'
                    : isDanger
                    ? 'text-sm text-red-600'
                    : 'text-sm text-neutral-500'
                }`}
              >
                {row.label}
              </div>
              <div
                className={`tabular-nums tracking-tight ${
                  isPrimary
                    ? 'text-2xl font-semibold text-neutral-900 leading-none'
                    : isDanger
                    ? 'text-sm font-medium text-red-700'
                    : 'text-sm font-medium text-neutral-700'
                }`}
              >
                {row.count.toLocaleString()}
              </div>
            </div>
          );
        })}
      </div>

      {total > 1 && rows.length > 1 && (
        <div className="px-4 flex items-baseline justify-between text-xs text-neutral-500">
          <span>Total processed</span>
          <span className="tabular-nums font-medium text-neutral-700">{total.toLocaleString()}</span>
        </div>
      )}

      {result.errors && result.errors.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer text-xs text-neutral-500 hover:text-neutral-700 select-none px-4">
            Show error details ({result.errors.length.toLocaleString()})
          </summary>
          <div className="mt-2 max-h-40 overflow-y-auto rounded-md border border-neutral-200 divide-y divide-neutral-100 text-xs">
            {result.errors.slice(0, 10).map((error, idx) => (
              <div key={idx} className="px-3 py-2 text-red-700">
                {error.error}
              </div>
            ))}
            {result.errors.length > 10 && (
              <div className="px-3 py-2 text-neutral-500">
                +{(result.errors.length - 10).toLocaleString()} more
              </div>
            )}
          </div>
        </details>
      )}
    </div>
  );
}

