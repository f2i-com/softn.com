<?php
declare(strict_types=1);

require_once __DIR__ . '/micro.php';

$router = new ModulaRouter('modula.website', 'Modula Website, eCommerce & Marketing', __DIR__ . '/schema.sql');

$router->get('/api/overview', function (PDO $pdo): array {
    $publishedPages = (int) ModulaDb::scalar($pdo, 'SELECT COUNT(*) FROM pages WHERE published = 1');
    $totalPages = (int) ModulaDb::scalar($pdo, 'SELECT COUNT(*) FROM pages');
    $ordersCount = (int) ModulaDb::scalar($pdo, 'SELECT COUNT(*) FROM store_orders');
    $storeRevenue = (float) ModulaDb::scalar($pdo, "SELECT COALESCE(SUM(total), 0) FROM store_orders WHERE status != 'Refunded'");
    $leadsCount = (int) ModulaDb::scalar($pdo, 'SELECT COUNT(*) FROM leads');
    $blogCount = (int) ModulaDb::scalar($pdo, 'SELECT COUNT(*) FROM blog_posts WHERE published = 1');
    $sentCampaigns = (int) ModulaDb::scalar($pdo, "SELECT COUNT(*) FROM campaigns WHERE status = 'Sent'");
    return [
        'publishedPages' => $publishedPages,
        'totalPages' => $totalPages,
        'ordersCount' => $ordersCount,
        'storeRevenue' => round($storeRevenue, 2),
        'leadsCount' => $leadsCount,
        'blogCount' => $blogCount,
        'sentCampaigns' => $sentCampaigns,
    ];
});

// Pages & Section Blocks
$router->get('/api/pages', function (PDO $pdo): array {
    $rows = ModulaDb::all($pdo, 'SELECT * FROM pages ORDER BY id ASC');
    foreach ($rows as &$r) {
        $r['blocks'] = json_decode((string) ($r['blocks_json'] ?? '[]'), true) ?: [];
    }
    return ['pages' => $rows];
});

$router->post('/api/pages', function (PDO $pdo): array {
    $in = ModulaHttp::body();
    $slug = ModulaHttp::str($in, 'slug', '', 80);
    $title = ModulaHttp::str($in, 'title', '', 120);
    if ($slug === '' || $title === '') {
        ModulaHttp::error('Slug and title are required.', 422);
    }
    if ($slug[0] !== '/') {
        $slug = '/' . $slug;
    }
    $id = ModulaDb::exec(
        $pdo,
        'INSERT INTO pages (slug, title, meta_desc, headline, subheadline, cta_label, accent_color, blocks_json, published, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)',
        [
            $slug,
            $title,
            ModulaHttp::str($in, 'meta_desc', '', 240),
            ModulaHttp::str($in, 'headline', $title, 240),
            ModulaHttp::str($in, 'subheadline', 'Built with Modula Website Builder.', 500),
            ModulaHttp::str($in, 'cta_label', 'Learn More', 60),
            ModulaHttp::str($in, 'accent_color', '#ea580c', 20),
            '[]',
            ModulaHttp::today(),
        ]
    );
    $row = ModulaDb::one($pdo, 'SELECT * FROM pages WHERE id = ?', [$id]);
    if ($row) {
        $row['blocks'] = [];
    }
    return ['__status' => 201, '__body' => ['page' => $row]];
});

$router->put('/api/pages/{id}', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    $page = ModulaDb::one($pdo, 'SELECT * FROM pages WHERE id = ?', [$id]);
    if (!$page) {
        ModulaHttp::error('Page not found.', 404);
    }
    $in = ModulaHttp::body();
    $blocks = isset($in['blocks']) && is_array($in['blocks']) ? $in['blocks'] : (json_decode((string) $page['blocks_json'], true) ?: []);
    ModulaDb::exec(
        $pdo,
        'UPDATE pages SET title = ?, meta_desc = ?, headline = ?, subheadline = ?, cta_label = ?, accent_color = ?, blocks_json = ?, published = ?, updated_at = ? WHERE id = ?',
        [
            ModulaHttp::str($in, 'title', (string) $page['title'], 120),
            ModulaHttp::str($in, 'meta_desc', (string) $page['meta_desc'], 240),
            ModulaHttp::str($in, 'headline', (string) $page['headline'], 240),
            ModulaHttp::str($in, 'subheadline', (string) $page['subheadline'], 500),
            ModulaHttp::str($in, 'cta_label', (string) $page['cta_label'], 60),
            ModulaHttp::str($in, 'accent_color', (string) $page['accent_color'], 20),
            json_encode($blocks, JSON_UNESCAPED_SLASHES),
            isset($in['published']) ? ((bool) $in['published'] ? 1 : 0) : (int) $page['published'],
            ModulaHttp::today(),
            $id,
        ]
    );
    $updated = ModulaDb::one($pdo, 'SELECT * FROM pages WHERE id = ?', [$id]);
    if ($updated) {
        $updated['blocks'] = $blocks;
    }
    return ['page' => $updated];
});

// Store Products & Orders
$router->get('/api/store/products', function (PDO $pdo): array {
    return ['products' => ModulaDb::all($pdo, 'SELECT * FROM store_products ORDER BY id ASC')];
});

$router->post('/api/store/products', function (PDO $pdo): array {
    $in = ModulaHttp::body();
    $name = ModulaHttp::str($in, 'name', '', 140);
    $sku = strtoupper(ModulaHttp::str($in, 'sku', '', 40));
    if ($name === '' || $sku === '') {
        ModulaHttp::error('Product name and SKU are required.', 422);
    }
    $id = ModulaDb::exec(
        $pdo,
        'INSERT INTO store_products (name, sku, category, price, stock, summary) VALUES (?, ?, ?, ?, ?, ?)',
        [
            $name,
            $sku,
            ModulaHttp::str($in, 'category', 'Hardware', 60),
            max(0.0, round(ModulaHttp::float($in, 'price', 99.0), 2)),
            max(0, ModulaHttp::int($in, 'stock', 10)),
            ModulaHttp::str($in, 'summary', '', 300),
        ]
    );
    return ['__status' => 201, '__body' => ['product' => ModulaDb::one($pdo, 'SELECT * FROM store_products WHERE id = ?', [$id])]];
});

$router->get('/api/store/orders', function (PDO $pdo): array {
    return ['orders' => ModulaDb::all($pdo, 'SELECT * FROM store_orders ORDER BY id DESC')];
});

$router->post('/api/store/orders', function (PDO $pdo): array {
    $in = ModulaHttp::body();
    $customer = ModulaHttp::str($in, 'customer_name', '', 120);
    $email = ModulaHttp::str($in, 'customer_email', '', 140);
    $promo = strtoupper(ModulaHttp::str($in, 'promo_code', '', 30));
    $cart = isset($in['items']) && is_array($in['items']) ? $in['items'] : [];
    if ($customer === '' || count($cart) === 0) {
        ModulaHttp::error('Customer name and at least one cart item are required.', 422);
    }

    $summaryParts = [];
    $subtotal = 0.0;
    $pdo->beginTransaction();
    try {
        foreach ($cart as $item) {
            if (!is_array($item)) {
                continue;
            }
            $pid = (int) ($item['product_id'] ?? 0);
            $qty = max(1, (int) ($item['qty'] ?? 1));
            $prod = ModulaDb::one($pdo, 'SELECT * FROM store_products WHERE id = ?', [$pid]);
            if (!$prod) {
                throw new RuntimeException('Product #' . $pid . ' not found.');
            }
            if ((int) $prod['stock'] < $qty) {
                throw new RuntimeException('Insufficient stock for ' . $prod['name']);
            }
            ModulaDb::exec($pdo, 'UPDATE store_products SET stock = stock - ? WHERE id = ?', [$qty, $pid]);
            $subtotal += $qty * (float) $prod['price'];
            $summaryParts[] = $qty . ' x ' . $prod['name'];
        }
        $discountRate = $promo === 'MODULA10' ? 0.10 : ($promo === 'SAVE20' ? 0.20 : 0.0);
        $discount = round($subtotal * $discountRate, 2);
        $total = round($subtotal - $discount, 2);
        $seq = ((int) ModulaDb::scalar($pdo, 'SELECT COUNT(*) FROM store_orders')) + 301;
        $orderNo = 'WEB-2026-' . $seq;
        $id = ModulaDb::exec(
            $pdo,
            'INSERT INTO store_orders (order_number, customer_name, customer_email, items_summary, promo_code, discount_amount, total, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [$orderNo, $customer, $email, implode(', ', $summaryParts), $discountRate > 0 ? $promo : '', $discount, $total, 'Confirmed', ModulaHttp::now()]
        );
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        ModulaHttp::error($e->getMessage(), 400);
    }

    return ['__status' => 201, '__body' => ['order' => ModulaDb::one($pdo, 'SELECT * FROM store_orders WHERE id = ?', [$id])]];
});

$router->patch('/api/store/orders/{id}/status', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    $in = ModulaHttp::body();
    $status = ModulaHttp::str($in, 'status', '', 30);
    if (!in_array($status, ['Confirmed', 'Shipped', 'Fulfilled', 'Refunded'], true)) {
        ModulaHttp::error('Invalid order status.', 422);
    }
    ModulaDb::exec($pdo, 'UPDATE store_orders SET status = ? WHERE id = ?', [$status, $id]);
    return ['order' => ModulaDb::one($pdo, 'SELECT * FROM store_orders WHERE id = ?', [$id])];
});

// Blog CMS
$router->get('/api/blog', function (PDO $pdo): array {
    return ['posts' => ModulaDb::all($pdo, 'SELECT * FROM blog_posts ORDER BY id DESC')];
});

$router->post('/api/blog', function (PDO $pdo): array {
    $in = ModulaHttp::body();
    $title = ModulaHttp::str($in, 'title', '', 180);
    $body = ModulaHttp::str($in, 'body', '', 8000);
    if ($title === '' || $body === '') {
        ModulaHttp::error('Blog title and body are required.', 422);
    }
    $slug = strtolower((string) preg_replace('/[^a-z0-9]+/i', '-', $title));
    $slug = trim($slug, '-') . '-' . time();
    $id = ModulaDb::exec(
        $pdo,
        'INSERT INTO blog_posts (slug, title, author, tag, excerpt, body, published, published_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
        [
            $slug,
            $title,
            ModulaHttp::str($in, 'author', 'Modula Team', 80),
            ModulaHttp::str($in, 'tag', 'Product', 40),
            ModulaHttp::str($in, 'excerpt', substr($body, 0, 140), 260),
            $body,
            ModulaHttp::today(),
        ]
    );
    return ['__status' => 201, '__body' => ['post' => ModulaDb::one($pdo, 'SELECT * FROM blog_posts WHERE id = ?', [$id])]];
});

$router->patch('/api/blog/{id}/toggle', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    $post = ModulaDb::one($pdo, 'SELECT * FROM blog_posts WHERE id = ?', [$id]);
    if (!$post) {
        ModulaHttp::error('Post not found.', 404);
    }
    $next = ((int) $post['published']) === 1 ? 0 : 1;
    ModulaDb::exec($pdo, 'UPDATE blog_posts SET published = ? WHERE id = ?', [$next, $id]);
    return ['post' => ModulaDb::one($pdo, 'SELECT * FROM blog_posts WHERE id = ?', [$id])];
});

// Email Marketing Campaigns
$router->get('/api/campaigns', function (PDO $pdo): array {
    return ['campaigns' => ModulaDb::all($pdo, 'SELECT * FROM campaigns ORDER BY id DESC')];
});

$router->post('/api/campaigns', function (PDO $pdo): array {
    $in = ModulaHttp::body();
    $name = ModulaHttp::str($in, 'name', '', 140);
    $subject = ModulaHttp::str($in, 'subject', '', 180);
    if ($name === '' || $subject === '') {
        ModulaHttp::error('Campaign name and email subject are required.', 422);
    }
    $id = ModulaDb::exec(
        $pdo,
        "INSERT INTO campaigns (name, subject, audience, body, recipients, open_rate, status, sent_at) VALUES (?, ?, ?, ?, 0, 0, 'Draft', '')",
        [$name, $subject, ModulaHttp::str($in, 'audience', 'All Leads & Customers', 80), ModulaHttp::str($in, 'body', '', 3000)]
    );
    return ['__status' => 201, '__body' => ['campaign' => ModulaDb::one($pdo, 'SELECT * FROM campaigns WHERE id = ?', [$id])]];
});

$router->post('/api/campaigns/{id}/send', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    $camp = ModulaDb::one($pdo, 'SELECT * FROM campaigns WHERE id = ?', [$id]);
    if (!$camp) {
        ModulaHttp::error('Campaign not found.', 404);
    }
    $leadEmails = (int) ModulaDb::scalar($pdo, 'SELECT COUNT(DISTINCT email) FROM leads');
    $orderEmails = (int) ModulaDb::scalar($pdo, 'SELECT COUNT(DISTINCT customer_email) FROM store_orders');
    $recipients = max(1, $leadEmails + $orderEmails);
    ModulaDb::exec(
        $pdo,
        "UPDATE campaigns SET status = 'Sent', recipients = ?, open_rate = 58.4, sent_at = ? WHERE id = ?",
        [$recipients, ModulaHttp::now(), $id]
    );
    return ['campaign' => ModulaDb::one($pdo, 'SELECT * FROM campaigns WHERE id = ?', [$id])];
});

// Leads
$router->get('/api/leads', function (PDO $pdo): array {
    return ['leads' => ModulaDb::all($pdo, 'SELECT * FROM leads ORDER BY id DESC')];
});

$router->post('/api/leads', function (PDO $pdo): array {
    $in = ModulaHttp::body();
    $name = ModulaHttp::str($in, 'name', '', 120);
    $email = ModulaHttp::str($in, 'email', '', 140);
    $message = ModulaHttp::str($in, 'message', '', 1000);
    if ($name === '' || $email === '' || $message === '') {
        ModulaHttp::error('Name, email, and message are required.', 422);
    }
    $id = ModulaDb::exec(
        $pdo,
        'INSERT INTO leads (name, email, company, message, source_page, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [$name, $email, ModulaHttp::str($in, 'company', '', 120), $message, ModulaHttp::str($in, 'source_page', '/', 80), 'New', ModulaHttp::now()]
    );
    return ['__status' => 201, '__body' => ['lead' => ModulaDb::one($pdo, 'SELECT * FROM leads WHERE id = ?', [$id])]];
});

$router->patch('/api/leads/{id}/status', function (PDO $pdo, array $params): array {
    $id = (int) $params['id'];
    $in = ModulaHttp::body();
    $status = ModulaHttp::str($in, 'status', 'Qualified', 30);
    ModulaDb::exec($pdo, 'UPDATE leads SET status = ? WHERE id = ?', [$status, $id]);
    return ['lead' => ModulaDb::one($pdo, 'SELECT * FROM leads WHERE id = ?', [$id])];
});

$router->dispatch();
