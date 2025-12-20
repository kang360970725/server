const { PrismaClient } = require('@prisma/client')

const prisma = new PrismaClient()

async function main() {
    console.log('Testing database connection...')

    // 创建测试用户
    const user = await prisma.user.create({
        data: {
            phone: '13800138000',
            password: 'encrypted_password',
            name: '测试用户',
        },
    })
    console.log('Created user:', user)

    console.log('✅ Database connection successful!')
}

main()
    .catch(e => {
        console.error('❌ Database connection failed:', e)
    })
    .finally(async () => {
        await prisma.$disconnect()
    })
