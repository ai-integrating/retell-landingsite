{
  "type": "object",
  "properties": {
    "action": {
      "type": "string",
      "enum": ["get_summary", "get_inventory", "get_market_price", "place_order"],
      "description": "The action to perform"
    },
    "species": {
      "type": "string",
      "description": "The seafood species or size, such as U-10 Scallops, Market Cod, Scrod Haddock, or Pollock"
    },
    "buyer_name": {
      "type": "string",
      "description": "The buyer name for the order"
    },
    "quantity_lbs": {
      "type": "number",
      "description": "The quantity in pounds for the order"
    },
    "shipping_destination": {
      "type": "string",
      "description": "The shipping destination for the order"
    }
  },
  "required": ["action"]
}
