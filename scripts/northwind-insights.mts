import Database from 'better-sqlite3';

const db = new Database('/opt/eliezer/data/northwind.db');

// Revenue by category
const revenueByCategory = db.prepare(`
  SELECT 
    c.CategoryName,
    COUNT(DISTINCT o.OrderID) as orderCount,
    SUM(od.UnitPrice * od.Quantity * (1 - od.Discount)) as revenue,
    SUM(od.Quantity) as unitsSold
  FROM Categories c
  JOIN Products p ON c.CategoryID = p.CategoryID
  JOIN "Order Details" od ON p.ProductID = od.ProductID
  JOIN Orders o ON od.OrderID = o.OrderID
  GROUP BY c.CategoryID, c.CategoryName
  ORDER BY revenue DESC
`).all();

// Sales over time (by month/year)
const salesByMonth = db.prepare(`
  SELECT 
    strftime('%Y-%m', o.OrderDate) as month,
    COUNT(DISTINCT o.OrderID) as orders,
    SUM(od.UnitPrice * od.Quantity * (1 - od.Discount)) as revenue
  FROM Orders o
  JOIN "Order Details" od ON o.OrderID = od.OrderID
  WHERE o.OrderDate IS NOT NULL
  GROUP BY month
  ORDER BY month
`).all();

// Top customers
const topCustomers = db.prepare(`
  SELECT 
    c.CompanyName,
    c.Country,
    COUNT(DISTINCT o.OrderID) as orderCount,
    SUM(od.UnitPrice * od.Quantity * (1 - od.Discount)) as totalSpent,
    AVG(od.UnitPrice * od.Quantity * (1 - od.Discount)) as avgOrderValue
  FROM Customers c
  JOIN Orders o ON c.CustomerID = o.CustomerID
  JOIN "Order Details" od ON o.OrderID = od.OrderID
  GROUP BY c.CustomerID
  ORDER BY totalSpent DESC
  LIMIT 10
`).all();

// Top products
const topProducts = db.prepare(`
  SELECT 
    p.ProductName,
    c.CategoryName,
    SUM(od.Quantity) as unitsSold,
    SUM(od.UnitPrice * od.Quantity * (1 - od.Discount)) as revenue,
    p.UnitPrice as currentPrice
  FROM Products p
  JOIN Categories c ON p.CategoryID = c.CategoryID
  JOIN "Order Details" od ON p.ProductID = od.ProductID
  GROUP BY p.ProductID
  ORDER BY revenue DESC
  LIMIT 10
`).all();

// Sales by employee
const employeeSales = db.prepare(`
  SELECT 
    e.FirstName || ' ' || e.LastName as employeeName,
    e.Title,
    COUNT(DISTINCT o.OrderID) as ordersHandled,
    SUM(od.UnitPrice * od.Quantity * (1 - od.Discount)) as totalSales,
    strftime('%Y', e.HireDate) as hiredYear
  FROM Employees e
  JOIN Orders o ON e.EmployeeID = o.EmployeeID
  JOIN "Order Details" od ON o.OrderID = od.OrderID
  GROUP BY e.EmployeeID
  ORDER BY totalSales DESC
`).all();

// Order stats
const orderStats = db.prepare(`
  SELECT 
    COUNT(*) as totalOrders,
    COUNT(DISTINCT CustomerID) as uniqueCustomers,
    COUNT(DISTINCT EmployeeID) as activeEmployees,
    MIN(OrderDate) as firstOrder,
    MAX(OrderDate) as lastOrder,
    AVG(julianday(ShippedDate) - julianday(OrderDate)) as avgShipDays
  FROM Orders
  WHERE OrderDate IS NOT NULL AND ShippedDate IS NOT NULL
`).get();

// Country breakdown
const salesByCountry = db.prepare(`
  SELECT 
    c.Country,
    COUNT(DISTINCT o.OrderID) as orders,
    SUM(od.UnitPrice * od.Quantity * (1 - od.Discount)) as revenue,
    COUNT(DISTINCT c.CustomerID) as customers
  FROM Customers c
  JOIN Orders o ON c.CustomerID = o.CustomerID
  JOIN "Order Details" od ON o.OrderID = od.OrderID
  GROUP BY c.Country
  ORDER BY revenue DESC
  LIMIT 15
`).all();

const insights = {
  revenueByCategory,
  salesByMonth,
  topCustomers,
  topProducts,
  employeeSales,
  orderStats,
  salesByCountry,
  summary: {
    totalRevenue: revenueByCategory.reduce((sum, c) => sum + c.revenue, 0),
    totalOrders: orderStats.totalOrders,
    totalCustomers: orderStats.uniqueCustomers,
    totalProducts: db.prepare('SELECT COUNT(*) as count FROM Products').get().count,
    avgOrderValue: db.prepare(`
      SELECT AVG(total) as avgValue FROM (
        SELECT SUM(UnitPrice * Quantity * (1 - Discount)) as total
        FROM "Order Details"
        GROUP BY OrderID
      )
    `).get().avgValue
  }
};

console.log(JSON.stringify(insights, null, 2));
db.close();
