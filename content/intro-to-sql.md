# Intro to SQL: Course Guide

This guide is the companion document for **Intro to SQL**. It walks through the three ideas the course is built on: asking questions with queries, combining tables with joins, and making those questions fast with indexes. Every example uses one small schema, so you can type it into any PostgreSQL database and follow along.

## 1. The practice schema

Three tables describe a tiny online school: who the students are, which courses exist, and who enrolled where.

```sql
CREATE TABLE students (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  country    TEXT NOT NULL,
  joined_at  DATE NOT NULL
);

CREATE TABLE courses (
  id     SERIAL PRIMARY KEY,
  title  TEXT NOT NULL,
  price  NUMERIC(8,2) NOT NULL
);

CREATE TABLE enrollments (
  student_id  INT REFERENCES students(id),
  course_id   INT REFERENCES courses(id),
  enrolled_at DATE NOT NULL,
  PRIMARY KEY (student_id, course_id)
);
```

Note the composite primary key on `enrollments`: a student can enrol in a course only once. Letting the database enforce a rule like this is safer than checking it in application code.

## 2. Queries: asking one table a question

A query names the columns you want, the table they come from, and the rows to keep.

```sql
SELECT name, country
FROM students
WHERE joined_at >= DATE '2026-01-01'
ORDER BY name;
```

Read it from the middle out: **FROM** picks the table, **WHERE** keeps matching rows, **SELECT** chooses the columns, **ORDER BY** sorts the result.

### Summaries with GROUP BY

To count students per country, group the rows and aggregate each group:

```sql
SELECT country, COUNT(*) AS students
FROM students
GROUP BY country
HAVING COUNT(*) >= 5
ORDER BY students DESC;
```

- `WHERE` filters rows **before** grouping.
- `HAVING` filters groups **after** aggregation.
- Every selected column must be grouped or aggregated.

### NULL is not a value

`NULL` means "unknown", so `x = NULL` is never true. Use `x IS NULL` or `x IS NOT NULL`, and remember that `COUNT(column)` skips NULLs while `COUNT(*)` counts every row.

## 3. Joins: combining tables

Real questions span tables. "Which courses did each student take?" needs all three:

```sql
SELECT s.name, c.title, e.enrolled_at
FROM enrollments e
JOIN students s ON s.id = e.student_id
JOIN courses  c ON c.id = e.course_id
ORDER BY s.name, e.enrolled_at;
```

The join types differ only in which unmatched rows they keep:

1. **INNER JOIN** keeps rows that match on both sides.
2. **LEFT JOIN** keeps every row from the left table, with NULLs where the right side has no match.
3. **RIGHT JOIN** is the mirror image; most people rewrite it as a LEFT JOIN.
4. **FULL JOIN** keeps unmatched rows from both sides.

A LEFT JOIN answers "who has never enrolled?":

```sql
SELECT s.name
FROM students s
LEFT JOIN enrollments e ON e.student_id = s.id
WHERE e.student_id IS NULL;
```

A common mistake is putting a condition on the right-hand table in `WHERE` instead of `ON`: it silently turns a LEFT JOIN back into an INNER JOIN.

## 4. Indexes: making queries fast

Without an index, finding rows means reading the whole table (a sequential scan). An index is a sorted structure, usually a B-tree, that lets the database jump straight to matching rows.

```sql
CREATE INDEX idx_enrollments_course ON enrollments (course_id);
```

Use `EXPLAIN ANALYZE` to see what the database actually does:

```sql
EXPLAIN ANALYZE
SELECT * FROM enrollments WHERE course_id = 42;
```

Look for **Index Scan** instead of **Seq Scan**, and compare the reported times.

### When indexes help, and when they cost

- They help on columns used in `WHERE`, `JOIN ... ON` and `ORDER BY`.
- Column order matters in a multi-column index: `(course_id, enrolled_at)` serves "by course" and "by course and date", but not "by date" alone.
- Every index slows down `INSERT`, `UPDATE` and `DELETE`, and uses disk space. Index what you query, not everything.
- Primary keys and `UNIQUE` constraints create indexes automatically.

## 5. Practice

1. List each course with its number of enrolments, including courses with none.
2. Find the three countries with the most students who joined this year.
3. Add an index that makes "enrolments of one student, newest first" fast, and confirm it with `EXPLAIN ANALYZE`.

When those feel easy, you are ready for window functions and transactions, the next steps after this course.
