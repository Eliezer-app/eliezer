import Database from 'better-sqlite3';

const db = new Database('/opt/eliezer/data/northwind.db');

// Aggregated data only - much smaller
const data = {
  summary: {
    totalRevenue: db.prepare(`
      SELECT SUM(UnitPrice * Quantity * (1 - Discount)) as val FROM "Order Details"
    `).get().val,
    totalOrders: db.prepare('SELECT COUNT(*) as val FROM Orders').get().val,
    uniqueCustomers: db.prepare('SELECT COUNT(DISTINCT CustomerID) as val FROM Orders').get().val,
    avgOrderValue: db.prepare(`
      SELECT AVG(total) as val FROM (
        SELECT SUM(UnitPrice * Quantity * (1 - Discount)) as total
        FROM "Order Details" GROUP BY OrderID
      )
    `).get().val,
    totalProducts: db.prepare('SELECT COUNT(*) as val FROM Products').get().val
  },
  
  // Top 5 only
  revenueByCategory: db.prepare(`
    SELECT c.CategoryName,
      COUNT(DISTINCT o.OrderID) as orderCount,
      SUM(od.UnitPrice * od.Quantity * (1 - od.Discount)) as revenue
    FROM Categories c
    JOIN Products p ON c.CategoryID = p.CategoryID
    JOIN "Order Details" od ON p.ProductID = od.ProductID
    JOIN Orders o ON od.OrderID = o.OrderID
    GROUP BY c.CategoryID ORDER BY revenue DESC
  `).all(),
  
  // Monthly aggregates only (30 points)
  salesByMonth: db.prepare(`
    SELECT strftime('%Y-%m', o.OrderDate) as month,
      SUM(od.UnitPrice * od.Quantity * (1 - od.Discount)) as revenue
    FROM Orders o JOIN "Order Details" od ON o.OrderID = od.OrderID
    WHERE o.OrderDate IS NOT NULL
    GROUP BY month ORDER BY month
  `).all(),
  
  // Top 5 customers
  topCustomers: db.prepare(`
    SELECT c.CompanyName, c.Country,
      COUNT(DISTINCT o.OrderID) as orderCount,
      SUM(od.UnitPrice * od.Quantity * (1 - od.Discount)) as totalSpent
    FROM Customers c
    JOIN Orders o ON c.CustomerID = o.CustomerID
    JOIN "Order Details" od ON o.OrderID = od.OrderID
    GROUP BY c.CustomerID ORDER BY totalSpent DESC LIMIT 5
  `).all(),
  
  // Top 5 products
  topProducts: db.prepare(`
    SELECT p.ProductName, c.CategoryName,
      SUM(od.Quantity) as unitsSold,
      SUM(od.UnitPrice * od.Quantity * (1 - od.Discount)) as revenue
    FROM Products p
    JOIN Categories c ON p.CategoryID = c.CategoryID
    JOIN "Order Details" od ON p.ProductID = od.ProductID
    GROUP BY p.ProductID ORDER BY revenue DESC LIMIT 5
  `).all(),
  
  // All employees (only 9)
  employeeSales: db.prepare(`
    SELECT e.FirstName || ' ' || e.LastName as employeeName,
      COUNT(DISTINCT o.OrderID) as ordersHandled,
      SUM(od.UnitPrice * od.Quantity * (1 - od.Discount)) as totalSales
    FROM Employees e
    JOIN Orders o ON e.EmployeeID = o.EmployeeID
    JOIN "Order Details" od ON o.OrderID = od.OrderID
    GROUP BY e.EmployeeID ORDER BY totalSales DESC
  `).all(),
  
  // Top 10 countries
  salesByCountry: db.prepare(`
    SELECT c.Country,
      COUNT(DISTINCT o.OrderID) as orders,
      SUM(od.UnitPrice * od.Quantity * (1 - od.Discount)) as revenue,
      COUNT(DISTINCT c.CustomerID) as customers
    FROM Customers c
    JOIN Orders o ON c.CustomerID = o.CustomerID
    JOIN "Order Details" od ON o.OrderID = od.OrderID
    GROUP BY c.Country ORDER BY revenue DESC LIMIT 10
  `).all()
};

console.log(JSON.stringify(data));
db.close();
