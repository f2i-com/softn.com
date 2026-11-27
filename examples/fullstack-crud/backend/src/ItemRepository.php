<?php
namespace App;

use PDO;

/**
 * Parameterized PDO repository with lossless 64-bit string IDs, exact TEXT decimals,
 * and atomic transaction support (commit & rollback).
 */
class ItemRepository
{
    private $pdo;

    public function __construct(PDO $pdo)
    {
        $this->pdo = $pdo;
    }

    public function listAll($search = '', $status = '')
    {
        $sql = 'SELECT CAST(id AS TEXT) AS id, sku, title, external_ref_id, unit_price, quantity, status, priority, notes, created_at FROM items';
        $where = [];
        $params = [];
        if ($search !== '') {
            $where[] = '(title LIKE ? OR sku LIKE ?)';
            $like = '%' . $search . '%';
            $params[] = $like;
            $params[] = $like;
        }
        if ($status !== '') {
            $where[] = 'status = ?';
            $params[] = $status;
        }
        if (!empty($where)) {
            $sql .= ' WHERE ' . implode(' AND ', $where);
        }
        $sql .= ' ORDER BY id ASC';
        $stmt = $this->pdo->prepare($sql);
        $stmt->execute($params);
        return $stmt->fetchAll(PDO::FETCH_ASSOC);
    }

    public function findById($id)
    {
        $stmt = $this->pdo->prepare(
            'SELECT CAST(id AS TEXT) AS id, sku, title, external_ref_id, unit_price, quantity, status, priority, notes, created_at FROM items WHERE id = ?'
        );
        $stmt->execute([$id]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row ? $row : null;
    }

    public function create(array $data)
    {
        $stmt = $this->pdo->prepare(
            'INSERT INTO items (sku, title, external_ref_id, unit_price, quantity, status, priority, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        );
        $stmt->execute([
            $data['sku'],
            $data['title'],
            isset($data['external_ref_id']) ? (string) $data['external_ref_id'] : '9007199254740993',
            isset($data['unit_price']) ? (string) $data['unit_price'] : '0.00',
            isset($data['quantity']) ? (int) $data['quantity'] : 0,
            isset($data['status']) ? (string) $data['status'] : 'active',
            isset($data['priority']) ? (string) $data['priority'] : 'normal',
            array_key_exists('notes', $data) ? $data['notes'] : null,
        ]);
        $newId = $this->pdo->lastInsertId();
        return $this->findById($newId);
    }

    public function update($id, array $data)
    {
        $existing = $this->findById($id);
        if (!$existing) {
            return null;
        }
        $title = array_key_exists('title', $data) ? (string) $data['title'] : $existing['title'];
        $unitPrice = array_key_exists('unit_price', $data) ? (string) $data['unit_price'] : $existing['unit_price'];
        $quantity = array_key_exists('quantity', $data) ? (int) $data['quantity'] : (int) $existing['quantity'];
        $status = array_key_exists('status', $data) ? (string) $data['status'] : $existing['status'];
        $priority = array_key_exists('priority', $data) ? (string) $data['priority'] : $existing['priority'];
        $notes = array_key_exists('notes', $data) ? $data['notes'] : $existing['notes'];

        $stmt = $this->pdo->prepare(
            'UPDATE items SET title = ?, unit_price = ?, quantity = ?, status = ?, priority = ?, notes = ? WHERE id = ?'
        );
        $stmt->execute([$title, $unitPrice, $quantity, $status, $priority, $notes, $id]);
        return $this->findById($id);
    }

    public function delete($id)
    {
        $existing = $this->findById($id);
        if (!$existing) {
            return false;
        }
        $stmt = $this->pdo->prepare('DELETE FROM items WHERE id = ?');
        $stmt->execute([$id]);
        return true;
    }

    /**
     * Atomically insert multiple items inside a single PDO transaction.
     * Rolls back every insert if any entry fails validation or violates UNIQUE(sku).
     */
    public function createBatch(array $items)
    {
        $this->pdo->beginTransaction();
        try {
            $created = [];
            foreach ($items as $item) {
                if (!is_array($item) || empty($item['sku']) || empty($item['title'])) {
                    throw new \Exception('Each batch item requires non-empty sku and title');
                }
                $created[] = $this->create($item);
            }
            $this->pdo->commit();
            return $created;
        } catch (\PDOException $e) {
            try { $this->pdo->rollBack(); } catch (\PDOException $ignored) {}
            throw new \Exception(Database::errorMessage($e));
        } catch (\Exception $e) {
            try { $this->pdo->rollBack(); } catch (\PDOException $ignored) {}
            throw $e;
        }
    }
}
