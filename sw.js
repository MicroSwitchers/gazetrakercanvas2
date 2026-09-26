const CACHE_NAME = 'gaze-tracker-v2026.09.25.007'; // Update this with each deployment
const APP_VERSION = '2026.09.25.007'; // Keep in sync with main app version
const urlsToCache = [
  './',
  './index.html',
  './manifest.json',
  './gazetracker.svg',
  './dist/output.css',
  './styles/main.css',
  './styles/library-layout.css',
  './styles/professional-theme.css',
  './styles/design-refresh.css',
  './js/shape-geometry.js',
  './js/layer-previews.js',
  './js/pencil-object.js',
  './js/symbol-library.js',
  './js/animation-motion.js',
  './js/media-store.js',
  './js/media-library.js',
  // JavaScript modules
  './js/pwa.js',
  './js/service-worker-manager.js',
  // Icons
  './icons/icon.svg',
  './icons/icon-16x16.png',
  './icons/icon-32x32.png',
  './icons/icon-48x48.png',
  './icons/icon-72x72.png',
  './icons/icon-96x96.png',
  './icons/icon-128x128.png',
  './icons/icon-144x144.png',
  './icons/icon-152x152.png',
  './icons/icon-192x192.png',
  './icons/icon-256x256.png',
  './icons/icon-384x384.png',
  './icons/icon-512x512.png',
  './icons/icon-maskable-192x192.png',
  './icons/icon-maskable-512x512.png',
  './icons/apple-touch-icon.png',
  // Splash screen tutorial pictures
  './complexitypicture.png',
  './salientfeatures.png',
  './grids.png',
  './path.png',
  './backgrounds.png',
  './alpha.png',
  './cbackground.png',
  // External fonts
  'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap',
  'https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:ital,wght@0,400;0,700;1,400;1,700&display=swap',
  'https://fonts.googleapis.com/css2?family=Andika:ital,wght@0,400;0,700;1,400;1,700&display=swap',
  'https://fonts.googleapis.com/css2?family=Noto+Serif:ital,wght@0,400;0,700;1,400;1,700&display=swap',
  // Self-hosted Luciole fonts
  './fonts/Luciole_webfonts/Luciole-Regular/Luciole-Regular.woff2',
  './fonts/Luciole_webfonts/Luciole-Regular/Luciole-Regular.woff',
  './fonts/Luciole_webfonts/Luciole-Bold/Luciole-Bold.woff2',
  './fonts/Luciole_webfonts/Luciole-Bold/Luciole-Bold.woff',
  './fonts/Luciole_webfonts/Luciole-Italic/Luciole-Italic.woff2',
  './fonts/Luciole_webfonts/Luciole-Italic/Luciole-Italic.woff',
  './fonts/Luciole_webfonts/Luciole-BoldItalic/Luciole-BoldItalic.woff2',
  './fonts/Luciole_webfonts/Luciole-BoldItalic/Luciole-BoldItalic.woff'
];

// Install Service Worker
self.addEventListener('install', (event) => {
  console.log('[Service Worker] Installing version:', APP_VERSION);
  
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('[Service Worker] Caching app shell');
        // Bypass the HTTP cache so a new version never stores stale CSS or assets.
        return Promise.allSettled(urlsToCache.map((url) =>
          cache.add(new Request(url, { cache: 'reload' })).catch((error) => console.warn('[Service Worker] Not cached:', url, error.message))
        ));
      })
      .catch((error) => {
        console.error('[Service Worker] Failed to cache:', error);
      })
      // Take over straight away so a normal reload shows the new version.
      .then(() => self.skipWaiting())
  );
});

// Activate Service Worker
self.addEventListener('activate', (event) => {
  console.log('[Service Worker] Activating version:', APP_VERSION);
  // Take control of all clients immediately
  event.waitUntil(
    Promise.all([
      // Clear old caches
      caches.keys().then((cacheNames) => {
        return Promise.all(
          cacheNames.map((cacheName) => {
            if (cacheName !== CACHE_NAME) {
              console.log('[Service Worker] Deleting old cache:', cacheName);
              return caches.delete(cacheName);
            }
          })
        );
      }),
      // Take control immediately
      self.clients.claim()
    ])
  );
});

// Fetch Strategy: Network First for HTML/JS, Cache First for Assets
self.addEventListener('fetch', (event) => {
  // Skip cross-origin requests (except fonts)
  if (event.request.method !== 'GET') return;
  const isFont = /fonts\.(googleapis|gstatic)\.com/.test(event.request.url);
  if (!event.request.url.startsWith(self.location.origin) && !isFont) {
    return;
  }
  // Font files never change: serve them from the cache, fetching and storing them the first time.
  if (isFont && event.request.url.includes('fonts.gstatic.com')) {
    event.respondWith(
      caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
        if (response && (response.ok || response.type === 'opaque')) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      }))
    );
    return;
  }

  // Network first for HTML, JavaScript and CSS so markup and styles always update together
  const requestPath = new URL(event.request.url).pathname;
  if (event.request.destination === 'document' ||
      event.request.destination === 'style' ||
      /\.(html|js|css)$/.test(requestPath)) {
    event.respondWith(
      fetch(event.request, { cache: 'no-cache' })
        .then((response) => {
          // Cache the fresh HTML/JS
          if (response && response.status === 200) {
            const responseToCache = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseToCache);
            });
          }
          return response;
        })
        .catch(async () => {
          // Offline: use the cached copy, ignoring query strings such as ?source=pwa.
          const cached = await caches.match(event.request, { ignoreSearch: true });
          if (cached) return cached;
          if (event.request.mode === 'navigate' || event.request.destination === 'document') {
            return (await caches.match('./index.html')) || (await caches.match('./'));
          }
          return Response.error();
        })
    );
    return;
  }

  // Cache first for other assets
  event.respondWith(
    caches.match(event.request)
      .then((response) => {
        // Return cached version or fetch from network
        if (response) {
          // For assets, check if we should refresh cache occasionally
          const cacheDate = response.headers.get('date');
          const now = new Date();
          const cacheAge = cacheDate ? (now - new Date(cacheDate)) / (1000 * 60 * 60) : 0;
          
          // Refresh cache for assets older than 1 hour
          if (cacheAge > 1) {
            fetch(event.request).then((freshResponse) => {
              if (freshResponse && freshResponse.status === 200) {
                caches.open(CACHE_NAME).then((cache) => {
                  cache.put(event.request, freshResponse.clone());
                });
              }
            }).catch(() => {}); // Ignore network errors for background updates
          }
          
          console.log('[Service Worker] Serving from cache:', event.request.url);
          return response;
        }

        console.log('[Service Worker] Fetching from network:', event.request.url);
        return fetch(event.request).then((response) => {
          // Don't cache non-successful responses
          if (!response || response.status !== 200 || response.type !== 'basic') {
            return response;
          }

          // Clone the response for caching
          const responseToCache = response.clone();
          caches.open(CACHE_NAME)
            .then((cache) => {
              cache.put(event.request, responseToCache);
            });

          return response;
        });
      })
      .catch(() => {
        // Return offline fallback for navigation requests
        if (event.request.destination === 'document') {
          return caches.match('./index.html');
        }
      })
  );
});

// Handle messages from main thread
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  
  if (event.data && event.data.type === 'GET_VERSION') {
    event.ports[0].postMessage({ version: APP_VERSION });
  }
  
  if (event.data && event.data.type === 'CLEAR_CACHE') {
    event.waitUntil(
      caches.keys().then((cacheNames) => {
        return Promise.all(
          cacheNames.map((cacheName) => caches.delete(cacheName))
        );
      }).then(() => {
        event.ports[0].postMessage({ success: true });
      })
    );
  }
});
