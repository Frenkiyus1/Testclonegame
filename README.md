# Pyramid Pass Online

Game co-op trực tuyến cho đúng **4 người**, mỗi người chơi trên một thiết bị riêng. Server Node.js + Socket.IO giữ trạng thái trận đấu và đồng bộ người chơi theo phòng.

## Tính năng

- Tạo phòng bằng mã 5 ký tự và chia sẻ link mời.
- Tối đa và yêu cầu đúng 4 người online để bắt đầu.
- Mỗi người điều khiển một nhân vật riêng trên máy/điện thoại của mình.
- Đồng bộ vị trí, Mặt Trời Vàng, xác ướp, bẫy cát, điểm, mạng và thời gian trên server.
- Tự nối lại khi mạng chập chờn; server giữ chỗ khoảng 30 giây.
- Điều khiển bàn phím và nút cảm ứng trên điện thoại.

## Chạy trên máy tính

Yêu cầu Node.js 20 trở lên.

```bash
npm install
npm start
```

Mở:

```text
http://localhost:3000
```

Để thử bằng nhiều cửa sổ trên cùng máy, mở bốn trình duyệt hoặc bốn hồ sơ trình duyệt khác nhau. Mỗi cửa sổ cần session lưu trữ riêng; chế độ ẩn danh có thể dùng để tạo thêm người chơi thử nghiệm.

## Điều khiển

- `WASD` hoặc phím mũi tên: di chuyển nhân vật của bạn.
- `Space`: chuyền Mặt Trời Vàng khi bạn đang giữ nó.
- `Shift`: lướt nhanh.
- Trên điện thoại: dùng cụm nút cảm ứng ở hai bên màn hình.

## Deploy lên Render

### Cách 1: dùng render.yaml

1. Tạo repository GitHub mới.
2. Upload toàn bộ nội dung thư mục này lên repository.
3. Trong Render, chọn **New > Blueprint**.
4. Chọn repository. Render đọc `render.yaml` và tạo Web Service.
5. Sau khi deploy xong, mở URL `onrender.com` được cấp và gửi link đó cho ba người còn lại.

### Cách 2: tạo Web Service thủ công

- Runtime: `Node`
- Build Command: `npm install`
- Start Command: `npm start`
- Health Check Path: `/health`

Server đã dùng `process.env.PORT` và lắng nghe trên `0.0.0.0`, phù hợp với Render.

## Cấu trúc

```text
pyramid_pass_online/
├── package.json
├── render.yaml
├── server.js
└── public/
    ├── index.html
    ├── style.css
    └── game.js
```

## Ghi chú triển khai

Bản này lưu phòng trong RAM. Khi dịch vụ restart, các phòng hiện tại sẽ mất. Một server instance là đủ cho bản demo và thi thử. Khi cần mở rộng nhiều instance, nên thêm Redis adapter cho Socket.IO và lưu trạng thái phòng ở kho dữ liệu dùng chung.
