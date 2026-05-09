const path = require("path");
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const jwt = require("jsonwebtoken");
const Razorpay = require("razorpay");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 5000;

const allowedOrigins = [
  "http://localhost:5173",
  "http://localhost:5174",
  "http://localhost:5175",
  "http://localhost:3000",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:5174",
  "http://127.0.0.1:5175",
  process.env.FRONTEND_URL,
  "https://tent-nine.vercel.app",
  "https://finebearing.vercel.app",
  "https://fine-bearing.vercel.app"
].filter(Boolean);

const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl)
    if (!origin) return callback(null, true);
    
    const isAllowed = allowedOrigins.includes(origin) || 
                     origin.includes("airoapp.ai") || 
                     origin.includes("localhost") ||
                     origin.includes("127.0.0.1");
                     
    if (isAllowed) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true
};

app.use(cors(corsOptions));


// For Razorpay webhooks, we need the raw body for signature verification
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(express.urlencoded({ extended: true }));
const multer = require("multer");
const { sendOtp, verifyOtp, sendSMSOrderAlert, sendAdminNewOrderAlert } = require("./twiloapi");

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
  console.log("Created uploads directory:", uploadsDir);
}

app.use("/uploads", express.static(uploadsDir));

// Multer storage config
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, "uploads"));
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  },
});

const upload = multer({ storage });

// Image Upload Endpoint
app.post("/api/upload", upload.single("image"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: "No file uploaded" });
  }
  const filePath = `/uploads/${req.file.filename}`;
  res.json({ filePath });
});

// PDF Catalogue Upload Endpoint
app.post("/api/upload-catalogue", upload.single("catalogue"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: "No file uploaded" });
  }

  const filePath = `/uploads/${req.file.filename}`;
  res.json({ filePath });
});

const PRODUCT_FILE = path.join(__dirname, "products_corrected.json");
const ORDER_FILE = path.join(__dirname, "orders.json");
const EMPLOYEE_FILE = path.join(__dirname, "employees.json");
const USER_FILE = path.join(__dirname, "users.json");
const QUOTE_FILE = path.join(__dirname, "quotes.json");
const JWT_SECRET = process.env.JWT_SECRET || "fallback_secret";
const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || "").trim();
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || "").trim();

const razorpay = (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET)
  ? new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    })
  : null;

console.log("Admin config loaded:", {
  usernameSet: !!ADMIN_USERNAME,
  passwordSet: !!ADMIN_PASSWORD,
  port: PORT
});

// helper: read products
const readProducts = () => {
  const data = fs.readFileSync(PRODUCT_FILE, "utf-8");
  return JSON.parse(data);
};

// helper: write products
const writeProducts = (products) => {
  fs.writeFileSync(PRODUCT_FILE, JSON.stringify(products, null, 2));
};

// helper: orders
const readOrders = () => {
  if (!fs.existsSync(ORDER_FILE)) return [];
  const data = fs.readFileSync(ORDER_FILE, "utf-8");
  return JSON.parse(data || "[]");
};

const writeOrders = (orders) => {
  fs.writeFileSync(ORDER_FILE, JSON.stringify(orders, null, 2));
};

// helper: users
const readUsers = () => {
  if (!fs.existsSync(USER_FILE)) fs.writeFileSync(USER_FILE, JSON.stringify([]));
  return JSON.parse(fs.readFileSync(USER_FILE));
};
const writeUsers = (data) => fs.writeFileSync(USER_FILE, JSON.stringify(data, null, 2));

// helper: employees
const readEmployees = () => {
  if (!fs.existsSync(EMPLOYEE_FILE)) return [];
  const data = fs.readFileSync(EMPLOYEE_FILE, "utf-8");
  return JSON.parse(data || "[]");
};

const writeEmployees = (employees) => {
  fs.writeFileSync(EMPLOYEE_FILE, JSON.stringify(employees, null, 2));
};

// helper: quotes
const readQuotes = () => {
  if (!fs.existsSync(QUOTE_FILE)) return [];
  const data = fs.readFileSync(QUOTE_FILE, "utf-8");
  return JSON.parse(data || "[]");
};

const writeQuotes = (quotes) => {
  fs.writeFileSync(QUOTE_FILE, JSON.stringify(quotes, null, 2));
};

// --- Secure Total Calculation Helper ---
const calculateOrderTotal = (cartItems, userId) => {
  const products = readProducts();
  const users = readUsers();

  // Calculate subtotal from DB prices to prevent frontend price manipulation
  let subtotal = 0;
  const itemsWithDetails = cartItems.map(item => {
    const product = products.find(p => p.id === item.id);
    if (!product) throw new Error(`Product with ID ${item.id} not found`);

    const itemTotal = product.price * item.quantity;
    subtotal += itemTotal;

    return {
      ...item,
      price: product.price,
      name: product.name,
      totalPrice: itemTotal
    };
  });

  // Apply user-specific discount from DB
  const user = users.find(u => u.id === userId || u.phone === userId);
  const discountPercent = user?.specialDiscount || 0;
  const discountAmount = (subtotal * discountPercent) / 100;

  const taxableAmount = subtotal - discountAmount;
  const gstAmount = taxableAmount * 0.18; // 18% GST
  const finalTotal = Math.round(taxableAmount + gstAmount);

  return {
    subtotal,
    discountAmount,
    taxableAmount,
    gstAmount,
    finalTotal,
    itemsWithDetails
  };
};

// login route for everyone
app.post("/api/auth/login", (req, res) => {
  const { username, password } = req.body;
  const trimmedUsername = username ? username.trim() : "";

  console.log(`--- Login Attempt ---`);
  console.log(`Input Username: "${trimmedUsername}"`);
  console.log(`Target Admin:   "${ADMIN_USERNAME}"`);

  // 1. Check for Admin (matches ADMIN_USERNAME and ADMIN_PASSWORD)
  const isUsernameMatch = trimmedUsername.toLowerCase() === ADMIN_USERNAME.toLowerCase();
  const isPasswordMatch = password === ADMIN_PASSWORD;

  console.log(`Debug Admin Match: UserMatch=${isUsernameMatch}, PassMatch=${isPasswordMatch}`);
  if (!isPasswordMatch) {
    console.log(`Password lengths: Received=${password?.length}, Expected=${ADMIN_PASSWORD?.length}`);
  }

  if (isUsernameMatch && isPasswordMatch) {
    console.log("RESULT: Admin match found!");
    const token = jwt.sign({ username: trimmedUsername, role: "admin" }, JWT_SECRET, { expiresIn: "7d" });
    return res.json({
      token,
      user: { username: trimmedUsername, name: "Administrator", role: "admin" },
    });
  }

  // 2. Check for Employee
  const employees = readEmployees();
  const employee = employees.find(e =>
    (e.username.toLowerCase() === trimmedUsername.toLowerCase() || e.email.toLowerCase() === trimmedUsername.toLowerCase()) &&
    e.password === password
  );
  if (employee) {
    console.log(`RESULT: Employee match found! (Role: ${employee.role})`);
    const userRole = employee.role?.toLowerCase() || "employee";
    const token = jwt.sign({ username: employee.username, role: userRole, permissions: employee.permissions }, JWT_SECRET, { expiresIn: "7d" });
    return res.json({
      token,
      user: { ...employee, role: userRole },
    });
  }

  // 3. Fallback for normal users (If password is correct for admin/staff but login failed above, it means it's a 401)
  // But wait, for normal users, we don't have a local database of passwords.
  // We only reach here if NO admin/staff matched.

  console.log("RESULT: No internal match. Falling back to 'user' role.");
  const users = readUsers();
  const existingUser = users.find(u => u.phone === trimmedUsername || u.username === trimmedUsername);

  const token = jwt.sign({ username: trimmedUsername, role: "user" }, JWT_SECRET, { expiresIn: "7d" });
  res.json({
    token,
    user: existingUser || { username: trimmedUsername, role: "user" },
  });
});


// --- Middleware ---

// auth middleware
const auth = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "No token provided" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ message: "Invalid token" });
  }
};

// admin middleware
const adminOnly = (req, res, next) => {
  if (req.user.role !== "admin") {
    return res.status(403).json({ message: "Admin only" });
  }
  next();
};

// employee or admin middleware
const employeeOrAdmin = (req, res, next) => {
  const role = req.user.role?.toLowerCase();
  if (role === "admin" || role === "employee" || role === "staff" || role === "manager") {
    next();
  } else {
    res.status(403).json({ message: "Employee or Admin access only" });
  }
};

// --- Twilio OTP Routes ---

// Send OTP
app.post("/api/auth/send-otp", async (req, res) => {
  const { phone } = req.body;
  console.log(`OTP Request for: ${phone}`);
  if (!phone) return res.status(400).json({ message: "Phone number is required" });

  try {
    const result = await sendOtp(phone);
    res.json(result);
  } catch (error) {
    console.error("Route OTP Error:", error.message);
    res.status(400).json({ message: error.message });
  }
});

// Verify OTP & Login
app.post("/api/auth/verify-otp", async (req, res) => {
  const { phone, otp } = req.body;
  if (!phone || !otp) return res.status(400).json({ message: "Phone and OTP are required" });

  const isValid = verifyOtp(phone, otp);
  if (!isValid) return res.status(401).json({ message: "Invalid or expired OTP" });

  // Generate token for the user
  const users = readUsers();
  const existingUser = users.find(u => u.phone === phone);

  const token = jwt.sign({ username: phone, role: "user" }, JWT_SECRET, { expiresIn: "7d" });

  res.json({
    success: true,
    token,
    user: existingUser || { username: phone, role: "user", phone: phone }
  });
});

// Verify OTP & Register
app.post("/api/auth/register-otp", async (req, res) => {
  const { phone, otp, name, company } = req.body;
  if (!phone || !otp || !name) {
    return res.status(400).json({ message: "Phone, OTP, and Name are required" });
  }

  const isValid = verifyOtp(phone, otp);
  if (!isValid) return res.status(401).json({ message: "Invalid or expired OTP" });

  const users = readUsers();
  // Check if phone already registered
  if (users.find(u => u.phone === phone)) {
    return res.status(400).json({ message: "This phone number is already registered. Please log in." });
  }

  const newUser = {
    id: Date.now().toString(),
    phone,
    name,
    company: company || "",
    role: "user",
    specialDiscount: 0, // Default discount
    createdAt: new Date().toISOString()
  };

  users.push(newUser);
  writeUsers(users);

  const token = jwt.sign({ username: phone, role: "user" }, JWT_SECRET, { expiresIn: "7d" });

  res.json({
    success: true,
    token,
    user: newUser
  });
});

// --- SMS Routes ---

// Manual SMS Alert
app.post("/api/sms/order-alert", auth, employeeOrAdmin, async (req, res) => {
  const { phone, orderId, status } = req.body;
  if (!phone || !orderId || !status) {
    return res.status(400).json({ message: "Phone, orderId, and status are required" });
  }

  try {
    const result = await sendSMSOrderAlert(phone, orderId, status);
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: "Failed to send SMS alert", error: error.message });
  }
});


// GET all products
app.get("/api/products", (req, res) => {
  try {
    const products = readProducts();
    res.json(products);
  } catch (error) {
    res.status(500).json({ message: "Failed to read products" });
  }
});

// GET single product
app.get("/api/products/:id", (req, res) => {
  try {
    const products = readProducts();
    const param = req.params.id;
    const isId = !isNaN(param);
    console.log(`Product lookup: param=${param}, isId=${isId}`);
    const product = products.find((p) => isId ? p.id === Number(param) : p.slug === param);
    console.log(`Product found: ${product ? product.name : 'null'}`);

    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    res.json(product);
  } catch (error) {
    res.status(500).json({ message: "Failed to read product" });
  }
});

// CREATE product - admin only
app.post("/api/products", auth, adminOnly, (req, res) => {
  try {
    const products = readProducts();

    const newProduct = {
      ...req.body,
      id: req.body.id ? Number(req.body.id) : (products.length ? Math.max(...products.map((p) => p.id)) + 1 : 1),
    };

    products.push(newProduct);
    writeProducts(products);

    res.status(201).json(newProduct);
  } catch (error) {
    res.status(500).json({ message: "Failed to create product" });
  }
});

// UPDATE product - admin only
app.put("/api/products/:id", auth, adminOnly, (req, res) => {
  try {
    const products = readProducts();
    const id = Number(req.params.id);

    const index = products.findIndex((p) => p.id === id);

    if (index === -1) {
      return res.status(404).json({ message: "Product not found" });
    }

    products[index] = {
      ...products[index],
      ...req.body,
      id: req.body.id ? Number(req.body.id) : id,
    };

    writeProducts(products);
    res.json(products[index]);
  } catch (error) {
    res.status(500).json({ message: "Failed to update product" });
  }
});

// --- SECURE RAZORPAY PAYMENT FLOW ---

// 1. Create Razorpay Order
// Frontend calls this with cart items and userId
app.post("/api/payment/create-order", async (req, res) => {
  try {
    const { items, userId, shippingAddress } = req.body;

    if (!items || !items.length) {
      return res.status(400).json({ message: "Cart is empty" });
    }

    // Securely calculate total on backend
    const { finalTotal, itemsWithDetails, subtotal, discountAmount, gstAmount } = calculateOrderTotal(items, userId);

    const options = {
      amount: finalTotal * 100, // Razorpay expects paise
      currency: "INR",
      receipt: `rcpt_${Date.now()}`,
    };

    const razorpayOrder = await razorpay.orders.create(options);

    // Create a local order with PENDING status
    const orders = readOrders();
    const newOrder = {
      orderId: `ORD_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      razorpayOrderId: razorpayOrder.id,
      userId: userId,
      items: itemsWithDetails,
      subtotal,
      discountAmount,
      gstAmount,
      total: finalTotal,
      shippingAddress,
      status: "PENDING",
      createdAt: new Date().toISOString(),
    };

    orders.push(newOrder);
    writeOrders(orders);

    // Return only necessary data to frontend
    res.json({
      id: razorpayOrder.id,
      amount: razorpayOrder.amount,
      currency: razorpayOrder.currency,
      localOrderId: newOrder.orderId
    });
  } catch (error) {
    console.error("Create Order Error:", error);
    res.status(500).json({ message: error.message || "Failed to create order" });
  }
});

// 2. Verify Payment Signature
// Frontend calls this after Razorpay Checkout success
app.post("/api/payment/verify", async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

  try {
    // SECURITY: Verify signature using HMAC SHA256
    const secret = process.env.RAZORPAY_KEY_SECRET;
    const body = razorpay_order_id + "|" + razorpay_payment_id;

    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(body.toString())
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ message: "Invalid payment signature" });
    }

    // Signature is valid, update local order
    const orders = readOrders();
    const orderIndex = orders.findIndex(o => o.razorpayOrderId === razorpay_order_id);

    if (orderIndex === -1) {
      return res.status(404).json({ message: "Order not found" });
    }

    // Prevent duplicate confirmation
    if (orders[orderIndex].status === "PAID" || orders[orderIndex].status === "Processing") {
      return res.json({ success: true, message: "Order already processed", order: orders[orderIndex] });
    }

    orders[orderIndex].status = "Processing";
    orders[orderIndex].razorpayPaymentId = razorpay_payment_id;
    orders[orderIndex].paidAt = new Date().toISOString();
    writeOrders(orders);

    // Trigger Notifications
    try {
      const { sendAdminNewOrderAlert } = require("./twiloapi");
      sendAdminNewOrderAlert(orders[orderIndex]).catch(err => console.error("Admin SMS Error:", err));
    } catch (e) {
      console.log("Notification service skipped or failed");
    }

    res.json({
      success: true,
      message: "Payment verified successfully",
      order: orders[orderIndex]
    });
  } catch (error) {
    console.error("Verification Error:", error);
    res.status(500).json({ message: "Verification failed" });
  }
});

// 3. Webhook for Async Payment Confirmation
// Razorpay calls this for events like order.paid
app.post("/api/payment/webhook", async (req, res) => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET || process.env.RAZORPAY_KEY_SECRET;
  const signature = req.headers["x-razorpay-signature"];

  try {
    // Verify Webhook Signature
    const shasum = crypto.createHmac("sha256", secret);
    shasum.update(req.rawBody);
    const digest = shasum.digest("hex");

    if (digest !== signature) {
      return res.status(400).json({ message: "Invalid webhook signature" });
    }

    const event = req.body;
    console.log("Razorpay Webhook Event:", event.event);

    if (event.event === "order.paid" || event.event === "payment.captured") {
      const razorpayOrderId = event.payload.order?.entity?.id || event.payload.payment.entity.order_id;

      const orders = readOrders();
      const orderIndex = orders.findIndex(o => o.razorpayOrderId === razorpayOrderId);

      if (orderIndex !== -1 && orders[orderIndex].status === "PENDING") {
        orders[orderIndex].status = "PAID";
        orders[orderIndex].razorpayPaymentId = event.payload.payment.entity.id;
        orders[orderIndex].paidAt = new Date().toISOString();
        writeOrders(orders);
        console.log(`Order ${razorpayOrderId} updated to PAID via Webhook`);
      }
    }

    res.status(200).send("OK");
  } catch (error) {
    console.error("Webhook Error:", error);
    res.status(500).send("Internal Server Error");
  }
});

// GET user orders
app.get("/api/orders/:username", (req, res) => {
  try {
    const orders = readOrders();
    const userOrders = orders.filter(o => o.userId === req.params.username || o.user?.email === req.params.username || o.user?.username === req.params.username);
    res.json(userOrders);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch orders" });
  }
});

// GET all orders (for Employee/Admin Panel)
app.get("/api/admin/orders", auth, employeeOrAdmin, (req, res) => {
  try {
    const orders = readOrders();
    res.json(orders);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch all orders" });
  }
});

// UPDATE order status (Employee/Admin)
app.patch("/api/admin/orders/:orderId/status", auth, employeeOrAdmin, (req, res) => {
  try {
    const { orderId } = req.params;
    const { status } = req.body;
    const orders = readOrders();
    const index = orders.findIndex(o => o.orderId === orderId);

    if (index === -1) return res.status(404).json({ message: "Order not found" });

    orders[index].status = status;
    writeOrders(orders);

    // Automatically send SMS alert if phone number is available
    const customerPhone = orders[index].shippingAddress?.phone || orders[index].userId;
    if (customerPhone) {
      console.log(`Triggering SMS alert for order ${orderId} to ${customerPhone}`);
      sendSMSOrderAlert(customerPhone, orderId, status)
        .catch(err => console.error("Auto SMS Alert Error:", err));
    } else {
      console.log(`No phone number found for order ${orderId}, skipping SMS alert.`);
    }

    res.json(orders[index]);
  } catch (error) {
    res.status(500).json({ message: "Failed to update order status" });
  }
});

// Employee Management (Admin Only)
app.get("/api/admin/employees", auth, adminOnly, (req, res) => {
  res.json(readEmployees());
});

app.post("/api/admin/employees", auth, adminOnly, (req, res) => {
  const employees = readEmployees();
  const newEmployee = {
    id: Date.now().toString(),
    ...req.body,
    permissions: req.body.permissions || ["view_orders", "edit_status"]
  };
  employees.push(newEmployee);
  writeEmployees(employees);
  res.json(newEmployee);
});

app.put("/api/admin/employees/:id", auth, adminOnly, (req, res) => {
  const employees = readEmployees();
  const index = employees.findIndex(e => e.id === req.params.id);
  if (index === -1) return res.status(404).json({ message: "Employee not found" });

  employees[index] = { ...employees[index], ...req.body };
  writeEmployees(employees);
  res.json(employees[index]);
});

app.delete("/api/admin/employees/:id", auth, adminOnly, (req, res) => {
  const employees = readEmployees();
  const filtered = employees.filter(e => e.id !== req.params.id);
  writeEmployees(filtered);
  res.json({ message: "Employee deleted" });
});

// User Management (Admin Only)
app.get("/api/admin/users", auth, adminOnly, (req, res) => {
  try {
    const users = readUsers();
    res.json(users);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch users" });
  }
});

app.patch("/api/admin/users/:id/discount", auth, adminOnly, (req, res) => {
  try {
    const { id } = req.params;
    const { specialDiscount } = req.body;
    const users = readUsers();
    const index = users.findIndex(u => u.id === id);

    if (index === -1) return res.status(404).json({ message: "User not found" });

    users[index].specialDiscount = Number(specialDiscount) || 0;
    writeUsers(users);

    res.json(users[index]);
  } catch (error) {
    res.status(500).json({ message: "Failed to update user discount" });
  }
});

app.patch("/api/admin/users/:id/gst", auth, adminOnly, (req, res) => {
  try {
    const { id } = req.params;
    const { gstNumber } = req.body;
    const users = readUsers();
    const index = users.findIndex(u => u.id === id);

    if (index === -1) return res.status(404).json({ message: "User not found" });

    users[index].gstNumber = gstNumber || "";
    writeUsers(users);

    res.json(users[index]);
  } catch (error) {
    res.status(500).json({ message: "Failed to update user GST" });
  }
});

app.delete("/api/products/:id", auth, adminOnly, (req, res) => {
  try {
    const products = readProducts();
    const id = Number(req.params.id);

    const filteredProducts = products.filter((p) => p.id !== id);

    if (filteredProducts.length === products.length) {
      return res.status(404).json({ message: "Product not found" });
    }

    writeProducts(filteredProducts);
    res.json({ message: "Product deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: "Failed to delete product" });
  }
});

// Update User Profile (Self)
app.post("/api/user/update-profile", auth, (req, res) => {
  try {
    const { name, email, company, gstNumber, profilePic } = req.body;
    const users = readUsers();
    // Find by phone or username (which is stored in token as username)
    const userIndex = users.findIndex(u => u.phone === req.user.username || u.username === req.user.username);

    if (userIndex === -1) {
      return res.status(404).json({ message: "User not found" });
    }

    // Update fields
    users[userIndex].name = name || users[userIndex].name;
    users[userIndex].email = email || users[userIndex].email;
    users[userIndex].company = company || users[userIndex].company;
    users[userIndex].gstNumber = gstNumber || users[userIndex].gstNumber;
    users[userIndex].profilePic = profilePic || users[userIndex].profilePic;

    writeUsers(users);

    res.json({
      success: true,
      message: "Profile updated successfully",
      user: users[userIndex]
    });
  } catch (error) {
    console.error("Profile Update Error:", error);
    res.status(500).json({ message: "Failed to update profile" });
  }
});

// Quote Request Endpoint (Saves to JSON and can forward to Google Sheets)
app.post("/api/request-quote", async (req, res) => {
  try {
    const quoteData = {
      id: `QT_${Date.now()}`,
      ...req.body,
      createdAt: new Date().toISOString(),
    };

    // 1. Save locally
    const quotes = readQuotes();
    quotes.push(quoteData);
    writeQuotes(quotes);

    // 2. Forward to Google Sheets if configured
    const googleSheetUrl = process.env.GOOGLE_SHEET_WEBHOOK_URL;
    if (googleSheetUrl) {
      try {
        const https = require("https");
        const dataString = JSON.stringify(quoteData);

        const options = {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': dataString.length,
          },
          timeout: 5000,
        };

        const reqGS = https.request(googleSheetUrl, options);
        reqGS.on('error', (e) => console.error("Google Sheet Forwarding Error:", e));
        reqGS.write(dataString);
        reqGS.end();
      } catch (gsError) {
        console.error("Failed to forward to Google Sheets:", gsError);
      }
    }

    res.status(201).json({ success: true, message: "Quote request received" });
  } catch (error) {
    console.error("Quote Request Error:", error);
    res.status(500).json({ message: "Failed to process quote request" });
  }
});

// --- Shipping Calculation Helpers ---
const determineZone = (state, city) => {
  const s = String(state).toLowerCase();
  const c = String(city).toLowerCase();

  // Shop is based in Ludhiana, Punjab
  if (c === "ludhiana") return "local";
  if (s === "punjab") return "state";

  const metroCities = ["mumbai", "delhi", "new delhi", "bangalore", "bengaluru", "kolkata", "chennai", "hyderabad", "ahmedabad", "pune"];
  if (metroCities.includes(c)) return "metro";

  return "national";
};

app.post("/api/calculate-shipping", (req, res) => {
  try {
    const { items, pincode, state, city } = req.body;
    if (!items || !items.length) {
      return res.status(400).json({ message: "Items are required" });
    }

    const products = readProducts();
    const zone = determineZone(state, city);

    const zoneRates = {
      local: 40,
      state: 60,
      metro: 80,
      national: 100
    };

    const zoneDays = {
      local: "1-2 Days",
      state: "2-4 Days",
      metro: "3-5 Days",
      national: "5-8 Days"
    };

    const baseCharge = 50;
    let totalWeight = 0;
    let shippingCharge = 0;

    items.forEach(item => {
      const product = products.find(p => p.id === item.id);
      if (!product) return;

      // Extract actual weight from specs (e.g., "1.9 kg")
      let actualWeight = parseFloat(product.specifications?.Weight || "0.5");

      // Extract dimensions (Defaults if missing)
      // For heavy products/scalable design, we look for L, W, H in specs
      const L = parseFloat(product.specifications?.Length || "10");
      const W = parseFloat(product.specifications?.Width || "10");
      const H = parseFloat(product.specifications?.Height || "10");

      const volumetricWeight = (L * W * H) / 5000;
      const finalWeight = Math.max(actualWeight, volumetricWeight);

      totalWeight += finalWeight * item.quantity;
    });

    // Round up total weight to nearest kg for pricing
    const finalBillableWeight = Math.ceil(totalWeight);
    shippingCharge = baseCharge + (finalBillableWeight * zoneRates[zone]);

    res.json({
      zone,
      charge: shippingCharge,
      days: zoneDays[zone],
      billableWeight: finalBillableWeight
    });
  } catch (error) {
    console.error("Shipping Calculation Error:", error);
    res.status(500).json({ message: "Failed to calculate shipping" });
  }
});

app.get("/", (req, res) => {
  res.send("Backend is live");
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

module.exports = app;

