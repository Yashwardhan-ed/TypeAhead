import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

// The dev server proxies /api → backend (see vite.config.js).
const API_BASE = '/api';
let userId = localStorage.getItem("user_id")
if (!userId) {
  userId = 'user_' + Math.random().toString(36).substring(2, 11) + '_' + Date.now().toString(36);
  localStorage.setItem("user_id", userId); 
}

// Normalize the /suggest response. The backend sometimes returns a JSON array
// directly, sometimes a JSON-encoded string of an array, sometimes an array of
// { value, score } entries from a Redis ZSET. Squash all of that into string[].
function normalizeSuggestions(data) {
  let arr = data
  if (typeof arr === 'string') {
    try { arr = JSON.parse(arr) } catch { return [] }
  }
  if (!Array.isArray(arr)) return []
  return arr
    .map((item) => {
      if (typeof item === 'string') return item
      if (item && typeof item === 'object') return item.value ?? item.member ?? ''
      return ''
    })
    .filter(Boolean)
    .slice(0, 10)
}

function useDebouncedValue(value, delay) {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(id)
  }, [value, delay])
  return debounced
}

function App() {
  const [query, setQuery] = useState('')
  const [suggestions, setSuggestions] = useState([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState(null)
  const [activeIndex, setActiveIndex] = useState(-1)
  const [isOpen, setIsOpen] = useState(false)
  const [searchResponse, setSearchResponse] = useState(null)
  const [trending, setTrending] = useState([])
  const [trendingError, setTrendingError] = useState(null)
  const [debugInfo, setDebugInfo] = useState(null)


  const inputRef = useRef(null)
  const requestIdRef = useRef(0)
  const toastTimerRef = useRef(null)

  const debouncedQuery = useDebouncedValue(query, 150)

  // Fetch trending on mount and after every successful submission.
  const loadTrending = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/suggest?q=`, {
        headers: { 'X-User-Id': userId },
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setTrending(normalizeSuggestions(data))
      setTrendingError(null)
    } catch (err) {
      setTrendingError(err.message || 'Failed to load trending')
    }
  }, [])

  useEffect(() => {
    loadTrending()
  }, [loadTrending])

  // Clear toast timer on unmount
  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    }
  }, [])

  // Suggestion fetcher, keyed by an incrementing request id so out-of-order
  // responses can't overwrite newer ones.
  useEffect(() => {
    const trimmed = debouncedQuery.trim()
    if (!trimmed) {
      setSuggestions([])
      setIsLoading(false)
      setError(null)
      return
    }

    const reqId = ++requestIdRef.current
    const controller = new AbortController()
    setIsLoading(true)
    setError(null)

    fetch(`${API_BASE}/suggest?q=${encodeURIComponent(trimmed)}`, {
      signal: controller.signal,
      headers: { 'X-User-Id': userId },
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      })
      .then((data) => {
        if (reqId !== requestIdRef.current) return
        setSuggestions(normalizeSuggestions(data))
        setIsLoading(false)
      })
      .catch((err) => {
        if (err.name === 'AbortError') return
        if (reqId !== requestIdRef.current) return
        setError(err.message || 'Failed to fetch suggestions')
        setSuggestions([])
        setIsLoading(false)
      })

    return () => controller.abort()
  }, [debouncedQuery])

  // Cache Debug Fetcher
  useEffect(() => {
    const trimmed = debouncedQuery.trim()
    if (!trimmed) {
      setDebugInfo(null)
      return
    }

    const controller = new AbortController()
    fetch(`${API_BASE}/cache/debug?prefix=${encodeURIComponent(trimmed)}`, {
      signal: controller.signal,
      headers: { 'X-User-Id': userId }
    })
      .then(res => {
        if (!res.ok) throw new Error()
        return res.json()
      })
      .then(data => {
        setDebugInfo(data)
      })
      .catch(() => {
        // Silently catch aborts or errors
      })

    return () => controller.abort()
  }, [debouncedQuery])


  const submitSearch = useCallback(async (raw) => {
    const value = (raw ?? query).trim()
    if (!value) return

    setIsOpen(false)
    setActiveIndex(-1)
    setQuery(value)

    try {
      // Backend may respond with a JSON body or just a 200.
      const res = await fetch(`${API_BASE}/search`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'X-User-ID': userId
        },
        body: JSON.stringify({ query: value }),
      })
      let message = 'Searched'
      const text = await res.text()
      if (text) {
        try { message = JSON.parse(text).message ?? text } catch { message = text }
      }
      
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
      setSearchResponse({ ok: res.ok, query: value, message })
      toastTimerRef.current = setTimeout(() => {
        setSearchResponse(null)
      }, 3500)

      // Give the backend a beat to process the log, then refresh trending.
      setTimeout(loadTrending, 250)
    } catch (err) {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
      setSearchResponse({ ok: false, query: value, message: err.message || 'Request failed' })
      toastTimerRef.current = setTimeout(() => {
        setSearchResponse(null)
      }, 3500)
    }
  }, [query, loadTrending])


  const onKeyDown = (e) => {
    if (!isOpen) {
      if (e.key === 'Enter') {
        e.preventDefault()
        submitSearch()
      }
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => (suggestions.length ? (i + 1) % suggestions.length : -1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => (suggestions.length ? (i - 1 + suggestions.length) % suggestions.length : -1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (activeIndex >= 0 && suggestions[activeIndex]) {
        submitSearch(suggestions[activeIndex])
      } else {
        submitSearch()
      }
    } else if (e.key === 'Escape') {
      setIsOpen(false)
      setActiveIndex(-1)
    }
  }

  const showDropdown = isOpen && (isLoading || error || suggestions.length > 0 || query.trim().length > 0)

  const statusLine = useMemo(() => {
    if (isLoading) return 'Searching…'
    if (error) return `Error: ${error}`
    if (query.trim() && suggestions.length === 0) return 'No matches'
    return null
  }, [isLoading, error, query, suggestions.length])

  return (
    <div className="page">
      <header className="masthead">
        <h1>Search Typeahead</h1>
        <p className="subtitle">Type to see suggestions ranked by popularity.</p>
      </header>

      <main className="main">
        <div className="searchbar-wrap">
          <div className="searchbar" role="combobox" aria-haspopup="listbox" aria-expanded={showDropdown}>
            <input
              ref={inputRef}
              type="text"
              className="search-input"
              placeholder="Search for anything…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setIsOpen(true)
                setActiveIndex(-1)
              }}
              onFocus={() => setIsOpen(true)}
              onBlur={() => setTimeout(() => setIsOpen(false), 120)}
              onKeyDown={onKeyDown}
              autoComplete="off"
              aria-autocomplete="list"
              aria-controls="suggestion-list"
              aria-activedescendant={activeIndex >= 0 ? `suggestion-${activeIndex}` : undefined}
            />
            <button
              type="button"
              className="search-button"
              onClick={() => submitSearch()}
              disabled={!query.trim()}
            >
              Search
            </button>
          </div>

          {showDropdown && (
            <div className="dropdown">
              {statusLine && <div className="status-line">{statusLine}</div>}
              {suggestions.length > 0 && (
                <ul id="suggestion-list" role="listbox" className="suggestion-list">
                  {suggestions.map((s, i) => (
                    <li
                      id={`suggestion-${i}`}
                      key={`${s}-${i}`}
                      role="option"
                      aria-selected={i === activeIndex}
                      className={`suggestion ${i === activeIndex ? 'active' : ''}`}
                      onMouseEnter={() => setActiveIndex(i)}
                      onMouseDown={(e) => {
                        e.preventDefault() // keep input focused
                        submitSearch(s)
                      }}
                    >
                      <HighlightMatch text={s} match={query.trim()} />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        {searchResponse && (
          <div className={`response-card ${searchResponse.ok ? 'ok' : 'err'}`}>
            <button 
              type="button" 
              className="toast-close" 
              onClick={() => {
                if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
                setSearchResponse(null)
              }}
              aria-label="Close notification"
            >
              &times;
            </button>
            <div className="response-title">
              {searchResponse.ok ? 'Response' : 'Search failed'}
            </div>
            <div className="response-body">
              <span className="response-message">{searchResponse.message}</span>
              <span className="response-query">for “{searchResponse.query}”</span>
            </div>
          </div>
        )}


        <section className="trending">
          <div className="trending-header">
            <h2>Trending</h2>
            <button type="button" className="refresh" onClick={loadTrending}>Refresh</button>
          </div>
          {trendingError && <div className="trending-error">Couldn't load trending: {trendingError}</div>}
          {!trendingError && trending.length === 0 && (
            <div className="trending-empty">No trending searches yet.</div>
          )}
          {trending.length > 0 && (
            <ol className="trending-list">
              {trending.map((t, i) => (
                <li key={`${t}-${i}`}>
                  <button
                    type="button"
                    className="trending-item"
                    onClick={() => {
                      setQuery(t)
                      submitSearch(t)
                      inputRef.current?.focus()
                    }}
                  >
                    <span className="rank">{i + 1}</span>
                    <span className="term">{t}</span>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </section>

        <CacheDebugger debugInfo={debugInfo} />
      </main>


      <footer className="footer">
        <span>Tip: use ↑ / ↓ to navigate suggestions, Enter to search, Esc to close.</span>
      </footer>
    </div>
  )
}

function HighlightMatch({ text, match }) {
  if (!match) return <>{text}</>
  const lower = text.toLowerCase()
  const idx = lower.indexOf(match.toLowerCase())
  if (idx === -1) return <>{text}</>
  return (
    <>
      {text.slice(0, idx)}
      <mark>{text.slice(idx, idx + match.length)}</mark>
      {text.slice(idx + match.length)}
    </>
  )
}

function CacheDebugger({ debugInfo }) {
  const [isOpen, setIsOpen] = useState(true)

  if (!debugInfo) return null

  return (
    <div className="debug-panel">
      <div className="debug-header" onClick={() => setIsOpen(!isOpen)}>
        <h3>🔍 Cache Routing & Performance</h3>
        <button type="button" className="toggle-btn">
          {isOpen ? 'Hide' : 'Show'}
        </button>
      </div>
      
      {isOpen && (
        <div className="debug-content">
          <div className="debug-item">
            <span className="debug-label">Prefix</span>
            <span className="debug-value">{debugInfo.prefix}</span>
          </div>
          <div className="debug-item">
            <span className="debug-label">Consistent Hash Key</span>
            <span className="debug-value">{debugInfo.cacheKey}</span>
          </div>
          <div className="debug-item">
            <span className="debug-label">Responsible Redis Node</span>
            <span className="debug-value">{debugInfo.responsibleNode || 'N/A'}</span>
          </div>
          <div className="debug-item">
            <span className="debug-label">L1 Local Cache (Memory)</span>
            <div>
              <span className={`badge ${debugInfo.L1?.status?.toLowerCase() === 'hit' ? 'hit' : 'miss'}`}>
                {debugInfo.L1?.status}
              </span>
            </div>
          </div>
          <div className="debug-item">
            <span className="debug-label">L2 Distributed Cache (Redis)</span>
            <div>
              <span className={`badge ${debugInfo.L2?.status?.toLowerCase() === 'hit' ? 'hit' : 'miss'}`}>
                {debugInfo.L2?.status}
              </span>
            </div>
          </div>
          <div className="debug-item">
            <span className="debug-label">Cache Level Result</span>
            <span className="debug-value" style={{ fontWeight: 600, color: debugInfo.L1?.status === 'HIT' ? '#10b981' : (debugInfo.L2?.status === 'HIT' ? '#3b82f6' : '#f59e0b') }}>
              {debugInfo.L1?.status === 'HIT' ? 'L1 Memory HIT (0ms)' : (debugInfo.L2?.status === 'HIT' ? 'L2 Redis HIT' : 'L3 DB Fallback (MISS)')}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

export default App

