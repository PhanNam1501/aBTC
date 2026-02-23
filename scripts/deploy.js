const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();

  console.log("🚀 Đang deploy lên MONAD MAINNET với ví:", deployer.address);
  
  // 1. Kiểm tra số dư ví (An toàn)
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("💰 Số dư ví:", hre.ethers.formatEther(balance), "MON");

  if (balance === 0n) {
    console.error("❌ Lỗi: Ví hết tiền (0 MON). Vui lòng nạp MON để làm phí gas.");
    process.exit(1);
  }

  // 2. Thiết lập Treasury & Registry
  // LƯU Ý: Trên Mainnet, nếu bạn chưa có Registry thật thì deploy mới.
  // Nếu đã có (ví dụ ERC-8004 chuẩn), hãy thay địa chỉ vào biến dưới đây.
  let registryAddress;
  
  // A. Deploy Registry mới (Nếu chưa có)
  console.log("\n--- [1/2] Deploying AgentIdentityRegistry ---");
  const Registry = await hre.ethers.getContractFactory("AgentIdentityRegistry");
  // Nếu contract Registry của bạn cần tham số constructor, điền vào .deploy(...)
  const registry = await Registry.deploy(); 
  await registry.waitForDeployment();
  registryAddress = registry.target;
  console.log("✅ Registry đã deploy tại:", registryAddress);

  // B. Hoặc dùng Registry có sẵn (Bỏ comment dòng dưới nếu muốn dùng cái cũ)
  // registryAddress = "0xĐịa_Chỉ_Registry_Của_Bạn";

  // Config Treasury (Lấy từ .env hoặc dùng chính ví deploy)
  const treasuryAddress = process.env.TREASURY_ADDRESS || deployer.address;
  console.log("🏦 Treasury Address:", treasuryAddress);

  // 3. Deploy aBTC_PoW
  console.log("\n--- [2/2] Deploying aBTC_PoW ---");
  const ABTC = await hre.ethers.getContractFactory("aBTC_PoW");
  const abtc = await ABTC.deploy(registryAddress, treasuryAddress);
  
  await abtc.waitForDeployment();
  const abtcAddress = abtc.target;
  console.log("✅ aBTC_PoW đã deploy tại:", abtcAddress);

  console.log("\n⏳ Đang chờ 5 block để index trên Explorer...");
  await abtc.deploymentTransaction().wait(5); 

  console.log("🔍 Bắt đầu Verify code...");
  try {
    // Verify aBTC
    await hre.run("verify:verify", {
      address: abtcAddress,
      constructorArguments: [registryAddress, treasuryAddress],
    });
    console.log("🌟 VERIFY THÀNH CÔNG!");
  } catch (error) {
    console.log("⚠️ Lỗi Verify (Có thể tự verify tay sau):", error.message);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });