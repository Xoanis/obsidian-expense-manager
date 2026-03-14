# Expense Manager for Obsidian

A comprehensive expense and income tracking plugin for Obsidian with support for multiple input methods including QR code receipts, manual entry, and Telegram bot integration.

## Features

### 📝 Multiple Input Methods
- **Manual Entry**: Quick modal interface for adding expenses and income
- **QR Code Receipts**: Scan receipt QR codes using [proverkacheka.com](https://proverkacheka.com) API
- **Telegram Bot**: Add expenses/income via Telegram messages (requires Telegram Bot plugin)

### 📊 Analytics & Reports
- Monthly expense reports with category breakdowns
- Visual charts and graphs (powered by Chart.js)
- Transaction lists with filtering capabilities
- Summary cards showing total income, expenses, and balance

### 💾 Data Storage
- Each transaction is stored as a separate markdown file
- YAML frontmatter for easy querying and filtering
- Organized in configurable folder structure

### 🔧 Extensible Architecture
- Handler-based design allows adding new input methods
- Future support planned for PDF bank statements
- Category management with predefined and custom tags

## Installation

### From Community Plugins (Pending)
1. Open Obsidian Settings
2. Go to Community plugins
3. Search for "Expense Manager"
4. Click Install and Enable

### Manual Installation
1. Download the latest release from GitHub
2. Extract files to `<vault>/.obsidian/plugins/expense-manager/`
3. Enable the plugin in Obsidian Settings → Community plugins

## Configuration

### Required Settings

**ProverkaCheka API Key** (for QR code processing):
1. Register at [proverkacheka.com](https://proverkacheka.com)
2. Get your API key from dashboard
3. Enter it in plugin settings

### Optional Settings

- **Expense Folder**: Where transaction files are stored (default: `Expenses`)
- **Default Currency**: Your primary currency (default: `RUB`)
- **Auto-save QR**: Skip review after QR processing (default: disabled)
- **Categories**: Manage predefined expense and income categories
- **Telegram Integration**: Enable/disable Telegram bot features

## Usage

### Adding Expenses

#### Method 1: Command Palette
1. Press `Ctrl/Cmd + P`
2. Select "Expense Manager: Add expense"
3. Fill in the form and save

#### Method 2: Ribbon Icon
1. Click the wallet icon in the left ribbon
2. Fill in expense details
3. Save

#### Method 3: QR Code Receipt
1. Press `Ctrl/Cmd + P`
2. Select "Expense Manager: Add expense via QR code"
3. Upload receipt image or drag & drop
4. Review processed data (or auto-save if enabled)
5. Edit if needed and save

#### Method 4: Telegram Bot
If you have the Telegram Bot plugin installed:
```
/expense 500 Lunch at cafe
/income 50000 Salary
```

### Generating Reports

1. Press `Ctrl/Cmd + P`
2. Select "Expense Manager: Generate monthly expense report"
3. View summary cards, category breakdown, and transaction list

### Data Structure

Each transaction creates a markdown file with this structure:

```markdown
---
type: expense
amount: 1500.00
currency: RUB
dateTime: 2024-03-13T14:30:00
comment: "Grocery shopping"
tags: ["groceries", "food"]
category: "Food"
source: qr
---

# Expense: Grocery shopping

**Date:** 2024-03-13 14:30
**Amount:** 1500.00 RUB
**Category:** Food
**Source:** qr

## Items
- Milk: 100.00 x 1 = 100.00
- Bread: 50.00 x 2 = 100.00
- ...
```

## Commands

| Command | Description |
|---------|-------------|
| `Add expense` | Open modal to add new expense |
| `Add income` | Open modal to add new income |
| `Add expense via QR code` | Process receipt QR code |
| `Generate monthly expense report` | View current month analytics |

## Keyboard Shortcuts

You can assign hotkeys to any command:
1. Settings → Hotkeys
2. Search for "Expense Manager"
3. Assign your preferred shortcuts

## Privacy & Security

- All data stored locally in your vault
- QR code images sent to proverkacheka.com API only when processing
- No telemetry or data collection
- Telegram integration requires separate Telegram Bot plugin

## Technical Details

### Dependencies
- **Chart.js**: For analytics visualization
- **proverkacheka.com API**: For QR code receipt processing

### File Naming Convention
Transactions are named automatically:
```
YYYY-MM-DD-HH-mm-ss-type-amount-comment.md
```

Example: `2024-03-13-14-30-00-exp-1500-grocery-shopping.md`

### Supported Image Formats for QR
- JPG/JPEG
- PNG
- WEBP
- GIF

## Troubleshooting

### QR Code Processing Fails
- Verify API key is correct in settings
- Check image quality (QR code must be clearly visible)
- Ensure image format is supported
- Check internet connection

### Plugin Doesn't Load
- Ensure `main.js`, `manifest.json`, and `styles.css` are in correct location
- Check Obsidian version (requires 0.15.0+)
- Try disabling and re-enabling plugin

### Telegram Integration Not Working
- Install Telegram Bot plugin first
- Enable Telegram integration in Expense Manager settings
- Restart Obsidian after enabling

## Development

### Build from Source

```bash
npm install
npm run dev      # Development mode (watch)
npm run build    # Production build
```

### Project Structure
```
src/
  commands/          # Command implementations
  handlers/          # Input method handlers
  services/          # Business logic
  ui/                # Modal components
  utils/             # Utility functions
  main.ts            # Plugin entry point
  settings.ts        # Settings interface
  types.ts           # TypeScript types
```

## Roadmap

### Planned Features
- [ ] PDF bank statement parsing
- [ ] Budget tracking and alerts
- [ ] Recurring transactions
- [ ] Multi-currency support with exchange rates
- [ ] Export to CSV/Excel
- [ ] Advanced filtering and search
- [ ] Dashboard view with quick stats
- [ ] Backup and sync utilities

## Contributing

Contributions welcome! Please:
1. Fork the repository
2. Create feature branch
3. Submit pull request

## License

MIT License - See LICENSE file for details

## Support

- **Issues**: Report bugs on GitHub Issues
- **Discussions**: Feature requests and questions on GitHub Discussions
- **Documentation**: Check this README and Obsidian help docs

## Acknowledgments

- Built with [Obsidian Sample Plugin](https://github.com/obsidianmd/obsidian-sample-plugin)
- QR processing powered by [proverkacheka.com](https://proverkacheka.com)
- Charts powered by [Chart.js](https://www.chartjs.org/)

---

**Made with ❤️ for the Obsidian community**
