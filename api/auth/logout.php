<?php
/**
 * logout.php — POST (with CSRF) to end the session server-side.
 */
declare(strict_types=1);
require __DIR__ . '/../lib.php';

require_method('POST');
require_csrf();
destroy_session();
json_out(['ok' => true]);
